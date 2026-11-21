package com.smsgateway

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The gateway connection - the native twin of what used to live in gateway.ts.
 *
 * WHY THIS IS NATIVE. The connection logic was originally in TypeScript, which is
 * far nicer to read and change. But it had one fatal flaw on real phones: Android
 * (Samsung above all) freezes a backgrounded app's JavaScript runtime once the
 * screen is off, and a frozen JS runtime is a dead heartbeat and a dead reconnect
 * timer. The socket itself stayed open - the OS was only freezing JS, not the
 * process - but the app could no longer prove it was alive or recover if it
 * dropped. So the whole state machine moved down here, onto a plain background
 * thread inside the foreground service, where the OS leaves it running.
 *
 * The design mirrors the old client exactly so the server sees no difference:
 *
 *  - **Its own thread.** Every bit of state is touched only on `handler`'s
 *    HandlerThread. OkHttp delivers socket events on its own threads; we bounce
 *    each one onto our handler so there is a single, race-free timeline.
 *  - **Liveness is OkHttp's ping.** `pingInterval` makes OkHttp ping the server
 *    and fail the socket if a pong does not come back - which is how a dead
 *    connection is noticed in the background and a reconnect is triggered without
 *    any JS. The app-level `heartbeat` frame is now telemetry only.
 *  - **It never gives up.** Backoff grows and then plateaus at 30s, forever. A
 *    phone acting as a modem loses its network constantly; an app that stops
 *    retrying is silently dead by Tuesday.
 */
object GatewayConnection {

    private const val TAG = "GatewayConnection"

    /** Everything the connection needs, handed down from JS once at start. */
    data class Config(
        val serverUrl: String,
        val apiKey: String,
        val deviceId: String,
        val deviceName: String,
        val simLabels: Map<String, String>,
        val heartbeatMs: Long,
    )

    /** How the connection tells the UI (via the module) what is happening. Best-effort: no-op when JS is frozen. */
    interface StatusSink {
        fun onStatus(state: String, detail: String?, gatewayId: String?)
        fun onLog(level: String, text: String)
        fun onSending(messageId: String, to: String, body: String, from: String?)
    }

    private val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 16_000)
    private const val MAX_BACKOFF_MS = 30_000L
    private const val DEFAULT_HEARTBEAT_MS = 30_000L

    // A single client for the life of the process. readTimeout 0 = never time out a
    // quiet-but-live socket; pingInterval is what actually decides liveness.
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    // One thread owns all mutable state. NOT the main thread, and emphatically NOT
    // the RN JS thread - the whole point is to run where the OS will not freeze us.
    private val thread = HandlerThread("gateway-connection").apply { start() }
    private val handler = Handler(thread.looper)

    private var appContext: Context? = null
    private var config: Config? = null
    private var sink: StatusSink? = null

    private var socket: WebSocket? = null
    private var stopped = true
    private var registered = false
    private var attempt = 0
    private var heartbeatMs = DEFAULT_HEARTBEAT_MS

    fun setSink(s: StatusSink?) {
        sink = s
    }

    /** Start (or restart) the connection with fresh config. Safe to call repeatedly. */
    fun start(context: Context, cfg: Config) {
        appContext = context.applicationContext
        handler.post {
            config = cfg
            stopped = false
            attempt = 0
            SmsSender.register(context.applicationContext)
            SmsSender.addCallback(smsCallback)
            // Drop any existing socket before opening a new one, so we never hold two.
            closeSocket("reconfigured")
            connect()
        }
    }

    /** Operator-requested stop. Cancels timers, closes the socket, unhooks from SmsSender. */
    fun stop() {
        handler.post {
            stopped = true
            registered = false
            handler.removeCallbacksAndMessages(null)
            SmsSender.removeCallback(smsCallback)
            closeSocket("stopped by user")
        }
    }

    // -------------------------------------------------------------------------
    // Socket lifecycle (all on the handler thread)
    // -------------------------------------------------------------------------

    private fun connect() {
        val cfg = config ?: return
        if (stopped) return

        registered = false
        emitStatus(if (attempt == 0) "connecting" else "reconnecting", null, null)

        val url = websocketUrl(cfg.serverUrl)
        emitLog("info", "Connecting to $url")

        val request = Request.Builder()
            .url(url)
            // A header keeps the API key out of the URL (and out of every proxy log).
            .addHeader("x-api-key", cfg.apiKey)
            .build()

        socket = client.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            handler.post { if (webSocket === socket) onOpen() }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handler.post { if (webSocket === socket) onMessage(text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Acknowledge the close so the socket shuts down cleanly.
            runCatching { webSocket.close(1000, null) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handler.post { if (webSocket === socket) onClose(code, reason) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handler.post { if (webSocket === socket) onClose(response?.code ?: 1006, t.message ?: "connection failure") }
        }
    }

    private fun onOpen() {
        if (stopped) return
        val cfg = config ?: return
        val ctx = appContext ?: return

        emitLog("info", "Connected - registering")

        val info = DeviceState.info(ctx)
        val sims = DeviceState.simReport(ctx, cfg.simLabels)
        val primary = firstSimNumber(sims) ?: info.phoneNumber

        send(JSONObject().apply {
            put("type", "register")
            put("deviceId", cfg.deviceId)
            put("deviceName", if (cfg.deviceName.isNotBlank()) cfg.deviceName else info.deviceName)
            put("batteryLevel", if (info.batteryLevel >= 0) info.batteryLevel else JSONObject.NULL)
            put("isCharging", info.isCharging)
            put("canSendSms", info.canSendSms)
            put("simOperator", info.simOperator ?: JSONObject.NULL)
            put("phoneNumber", primary ?: JSONObject.NULL)
            put("androidVersion", info.androidVersion)
            put("appVersion", "1.0.0")
            put("sims", sims)
        })
    }

    private fun onMessage(raw: String) {
        val frame = try {
            JSONObject(raw)
        } catch (_: Exception) {
            emitLog("warn", "Ignored a malformed frame from the server")
            return
        }

        when (frame.optString("type")) {
            "registered" -> {
                attempt = 0
                registered = true
                val gatewayId = frame.optString("gatewayId").ifBlank { null }
                emitStatus("online", null, gatewayId)
                emitLog("info", "Registered with the server")
                updateNotification("Connected - ready to send")
                val hb = frame.optLong("heartbeatIntervalMs", DEFAULT_HEARTBEAT_MS)
                startHeartbeat(if (hb > 0) hb else DEFAULT_HEARTBEAT_MS)
            }
            "sms.send" -> handleSend(frame)
            "calllog.request" -> handleCallLog(frame)
            "deviceSms.request" -> handleDeviceSms(frame)
            "heartbeat.ack" -> { /* nothing to do; the value is the server having heard us */ }
            "error" -> emitLog("error", "Server: ${frame.optString("message")}")
            else -> emitLog("warn", "Unknown frame type: ${frame.optString("type")}")
        }
    }

    private fun onClose(code: Int, reason: String) {
        registered = false
        handler.removeCallbacks(heartbeatRunnable)
        socket = null
        if (stopped) return

        emitLog("warn", "Disconnected: $reason ($code)")
        emitStatus("reconnecting", "$reason ($code)", null)
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val delay = if (attempt < BACKOFF_MS.size) BACKOFF_MS[attempt] else MAX_BACKOFF_MS
        attempt += 1
        updateNotification("Reconnecting in ${delay / 1000}s…")
        emitLog("info", "Reconnecting in ${delay / 1000}s")
        handler.postDelayed({ connect() }, delay)
    }

    private fun closeSocket(reason: String) {
        val s = socket
        socket = null
        if (s != null) runCatching { s.close(1000, reason) }
    }

    // -------------------------------------------------------------------------
    // Inbound frame handlers
    // -------------------------------------------------------------------------

    private fun handleSend(frame: JSONObject) {
        val ctx = appContext ?: return
        val messageId = frame.optString("messageId")
        val recipient = frame.optString("recipient")
        val body = frame.optString("body")
        // -1 means "the phone's default SIM"; only correct on a single-SIM handset.
        val subscriptionId = if (frame.has("subscriptionId") && !frame.isNull("subscriptionId")) {
            frame.optInt("subscriptionId", -1)
        } else {
            -1
        }
        val senderNumber = frame.optString("senderNumber").ifBlank { null }

        emitLog("info", "Sending to $recipient")
        sink?.onSending(messageId, recipient, body, senderNumber)

        try {
            SmsSender.send(ctx, messageId, recipient, body, subscriptionId)
        } catch (e: Exception) {
            // A synchronous refusal (no SIM, permission revoked): no async event is
            // coming, so report the failure here or the message sits SENDING forever.
            val message = e.message ?: "The device refused the message"
            emitLog("error", "Could not send: $message")
            send(JSONObject().apply {
                put("type", "sms.result")
                put("messageId", messageId)
                put("status", "FAILED")
                put("errorCode", "DEVICE_REFUSED")
                put("errorMessage", message)
            })
        }
    }

    private fun handleCallLog(frame: JSONObject) {
        val ctx = appContext ?: return
        val requestId = frame.optString("requestId")
        val limit = if (frame.has("limit")) frame.optInt("limit", 100) else 100
        val result = DeviceState.callLog(ctx, limit)
        send(JSONObject().apply {
            put("type", "calllog.response")
            put("requestId", requestId)
            put("granted", result.optBoolean("granted"))
            put("entries", result.optJSONArray("entries") ?: JSONArray())
        })
    }

    private fun handleDeviceSms(frame: JSONObject) {
        val ctx = appContext ?: return
        val requestId = frame.optString("requestId")
        val limit = if (frame.has("limit")) frame.optInt("limit", 100) else 100
        val result = DeviceState.deviceSms(ctx, limit)
        send(JSONObject().apply {
            put("type", "deviceSms.response")
            put("requestId", requestId)
            put("granted", result.optBoolean("granted"))
            put("messages", result.optJSONArray("messages") ?: JSONArray())
        })
    }

    // -------------------------------------------------------------------------
    // Heartbeat (telemetry, on the handler thread)
    // -------------------------------------------------------------------------

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (stopped || !registered) return
            val ctx = appContext ?: return
            val cfg = config ?: return

            val info = DeviceState.info(ctx)
            val sims = DeviceState.simReport(ctx, cfg.simLabels)

            send(JSONObject().apply {
                put("type", "heartbeat")
                put("batteryLevel", if (info.batteryLevel >= 0) info.batteryLevel else JSONObject.NULL)
                put("isCharging", info.isCharging)
                put("canSendSms", info.canSendSms)
                put("simOperator", info.simOperator ?: JSONObject.NULL)
                put("phoneNumber", (firstSimNumber(sims) ?: info.phoneNumber) ?: JSONObject.NULL)
                put("sims", sims)
            })

            val suffix = if (info.canSendSms) "" else " - CANNOT SEND (check SIM/permission)"
            val battery = if (info.batteryLevel >= 0) "${info.batteryLevel}%" else "?"
            updateNotification("Connected$suffix · $battery")

            handler.postDelayed(this, heartbeatMs)
        }
    }

    private fun startHeartbeat(intervalMs: Long) {
        heartbeatMs = intervalMs
        handler.removeCallbacks(heartbeatRunnable)
        handler.post(heartbeatRunnable)
    }

    // -------------------------------------------------------------------------
    // SmsSender bridge - a send outcome becomes a frame on the socket
    // -------------------------------------------------------------------------

    private val smsCallback = object : SmsSender.Callback {
        override fun onSent(messageId: String) {
            send(JSONObject().apply {
                put("type", "sms.result"); put("messageId", messageId); put("status", "SENT")
            })
        }

        override fun onFailed(messageId: String, errorCode: String, errorMessage: String) {
            send(JSONObject().apply {
                put("type", "sms.result"); put("messageId", messageId); put("status", "FAILED")
                put("errorCode", errorCode); put("errorMessage", errorMessage)
            })
        }

        override fun onDelivered(messageId: String) {
            send(JSONObject().apply {
                put("type", "sms.delivered"); put("messageId", messageId)
            })
        }
    }

    // -------------------------------------------------------------------------
    // Plumbing
    // -------------------------------------------------------------------------

    /** Serialise and send a frame. Silently drops it if the socket is not open - the outcome is visible upstream. */
    private fun send(frame: JSONObject) {
        val s = socket ?: return
        runCatching { s.send(frame.toString()) }.onFailure {
            emitLog("warn", "A frame could not be sent: ${it.message}")
        }
    }

    private fun emitStatus(state: String, detail: String?, gatewayId: String?) {
        runCatching { sink?.onStatus(state, detail, gatewayId) }
    }

    private fun emitLog(level: String, text: String) {
        Log.i(TAG, "[$level] $text")
        runCatching { sink?.onLog(level, text) }
    }

    private fun updateNotification(text: String) {
        appContext?.let { GatewayService.update(it, text) }
    }

    private fun firstSimNumber(sims: JSONArray): String? {
        if (sims.length() == 0) return null
        val first = sims.optJSONObject(0) ?: return null
        val number = first.optString("phoneNumber").ifBlank { null }
        return number
    }

    /**
     * The gateway WebSocket URL from the configured server URL: https -> wss,
     * anything else -> ws, and only the origin is used so a pasted `/admin` path
     * cannot corrupt it. Mirrors websocketUrl()/serverOrigin() in src/config.ts.
     */
    private fun websocketUrl(serverUrl: String): String {
        val trimmed = serverUrl.trim()
        val isHttps = trimmed.startsWith("https://", ignoreCase = true)
        val host = trimmed
            .replace(Regex("^https?://", RegexOption.IGNORE_CASE), "")
            .replace(Regex("[/?#].*$"), "")
        val scheme = if (isHttps) "wss://" else "ws://"
        return "$scheme$host/ws/gateway"
    }
}
