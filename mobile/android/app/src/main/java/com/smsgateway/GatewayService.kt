package com.smsgateway

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject

/**
 * The foreground service that keeps the gateway alive.
 *
 * Without this, the app is a toy. Android aggressively suspends a backgrounded
 * app's JavaScript - usually within a minute or two - and Doze mode will freeze
 * the process entirely when the screen has been off for a while. A gateway that
 * only sends SMS while you are actively looking at it is not a gateway.
 *
 * A foreground service is the one sanctioned escape hatch. The deal Android
 * offers is explicit: **you may keep running, but the user must be able to see
 * that you are.** Hence the permanent, non-dismissible notification. That is not
 * a design wart we are working around - it is the price, and it is a fair one for
 * an app that sends SMS from your SIM unattended.
 *
 * The service holds no logic of its own. The WebSocket, the protocol, the retry
 * behaviour all live in TypeScript; this exists purely so that the process
 * containing them is allowed to keep breathing.
 */
class GatewayService : Service() {

    companion object {
        private const val TAG = "GatewayService"

        private const val CHANNEL_ID = "sms_gateway_status"
        private const val NOTIFICATION_ID = 1

        const val EXTRA_STATUS = "status"
        const val ACTION_START = "com.smsgateway.START"
        const val ACTION_UPDATE = "com.smsgateway.UPDATE"
        const val ACTION_STOP = "com.smsgateway.STOP"

        private const val PREFS = "gateway_service"
        private const val KEY_RUNNING = "running"
        private const val KEY_SERVER_URL = "serverUrl"
        private const val KEY_API_KEY = "apiKey"
        private const val KEY_DEVICE_ID = "deviceId"
        private const val KEY_DEVICE_NAME = "deviceName"
        private const val KEY_SIM_LABELS = "simLabels"
        private const val KEY_HEARTBEAT = "heartbeatMs"

        /**
         * Start the foreground service AND the native connection.
         *
         * The config is persisted BEFORE the service starts, so that when Android
         * kills the process under memory pressure and restarts it (START_STICKY
         * hands onStartCommand a null intent on that restart), the service can
         * reload the config and reconnect entirely on its own - no Activity, no
         * JavaScript. That autonomous self-heal is the whole reason the connection
         * moved into native code.
         */
        fun start(context: Context, config: GatewayConnection.Config) {
            saveConfig(context, config)
            val intent = Intent(context, GatewayService::class.java).apply { action = ACTION_START }
            // startForegroundService, not startService: from a background context the
            // latter throws on Android 8+. We then have five seconds to call
            // startForeground() or the app is killed - hence the notification first.
            context.startForegroundService(intent)
        }

        fun update(context: Context, status: String) {
            val intent = Intent(context, GatewayService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_STATUS, status)
            }
            runCatching { context.startService(intent) }
        }

        fun stop(context: Context) {
            // Clear the running flag first, so a restart after this does NOT reconnect.
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_RUNNING, false).apply()
            val intent = Intent(context, GatewayService::class.java).apply { action = ACTION_STOP }
            runCatching { context.startService(intent) }
        }

        private fun saveConfig(context: Context, config: GatewayConnection.Config) {
            val labels = JSONObject()
            for ((key, value) in config.simLabels) labels.put(key, value)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_RUNNING, true)
                .putString(KEY_SERVER_URL, config.serverUrl)
                .putString(KEY_API_KEY, config.apiKey)
                .putString(KEY_DEVICE_ID, config.deviceId)
                .putString(KEY_DEVICE_NAME, config.deviceName)
                .putString(KEY_SIM_LABELS, labels.toString())
                .putLong(KEY_HEARTBEAT, config.heartbeatMs)
                .apply()
        }

        private fun loadConfig(context: Context): GatewayConnection.Config? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!prefs.getBoolean(KEY_RUNNING, false)) return null
            val serverUrl = prefs.getString(KEY_SERVER_URL, null) ?: return null
            val apiKey = prefs.getString(KEY_API_KEY, null) ?: return null
            val deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: return null

            val labels = mutableMapOf<String, String>()
            runCatching {
                val json = JSONObject(prefs.getString(KEY_SIM_LABELS, "{}") ?: "{}")
                for (key in json.keys()) labels[key] = json.getString(key)
            }

            return GatewayConnection.Config(
                serverUrl = serverUrl,
                apiKey = apiKey,
                deviceId = deviceId,
                deviceName = prefs.getString(KEY_DEVICE_NAME, "") ?: "",
                simLabels = labels,
                heartbeatMs = prefs.getLong(KEY_HEARTBEAT, 30_000L),
            )
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        SmsSender.register(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                GatewayConnection.stop()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_UPDATE -> {
                val status = intent.getStringExtra(EXTRA_STATUS) ?: "Connected"
                notificationManager().notify(NOTIFICATION_ID, buildNotification(status))
                return START_STICKY
            }

            else -> {
                // ACTION_START, OR a null intent when the OS restarts us after a
                // kill. Either way: become foreground within the 5s window, then
                // (re)start the native connection from the persisted config.
                startInForeground("Connecting…")

                val config = loadConfig(this)
                if (config == null) {
                    // No persisted config means there is nothing to run - a bare
                    // restart with the gateway already stopped. Don't sit idle
                    // holding a wake lock; shut down.
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return START_NOT_STICKY
                }

                GatewayConnection.start(this, config)
            }
        }

        // START_STICKY: if Android kills us under memory pressure, restart the
        // service as soon as there is room. A gateway that stays dead after one
        // bad afternoon is not one you can trust with an OTP.
        return START_STICKY
    }

    private fun startInForeground(status: String) {
        val notification = buildNotification(status)

        // Android 14+ demands the service declare WHAT it is doing in the
        // foreground, and will throw if the type here disagrees with the manifest.
        // dataSync is the honest description: we hold a network connection open to
        // exchange data with a server.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        acquireWakeLock()
        Log.i(TAG, "Gateway service is in the foreground")
    }

    /**
     * A partial wake lock keeps the CPU awake so the WebSocket's heartbeat can
     * actually fire while the screen is off.
     *
     * PARTIAL_WAKE_LOCK does not touch the screen - it only stops the CPU from
     * fully sleeping between events. Without it, Doze can still stall our timers
     * for minutes at a time, the server's heartbeat sweeper reaps us as dead, and
     * messages get dispatched to a socket nobody is reading.
     *
     * This costs battery. That is the deal with a device whose job is to be a
     * modem, and it is why the app tells the user to keep it plugged in.
     */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager

        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SmsGateway::Socket").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun buildNotification(status: String): Notification {
        // Tapping the notification returns to the app rather than launching a
        // second copy of it.
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("SMS Gateway")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(contentIntent)
            // Not swipe-away-able: if the user could dismiss it, they could
            // silently kill the thing that is sending their OTPs.
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun createChannel() {
        // IMPORTANCE_LOW: visible and permanent, but it must never make a sound or
        // pop up a heads-up banner. This notification will be on screen for weeks.
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Gateway status",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows that the SMS gateway is connected and able to send"
            setShowBadge(false)
        }

        notificationManager().createNotificationChannel(channel)
    }

    private fun notificationManager(): NotificationManager =
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null

        SmsSender.unregister(this)

        Log.i(TAG, "Gateway service stopped")
        super.onDestroy()
    }
}
