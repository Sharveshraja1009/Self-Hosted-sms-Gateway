package com.smsgateway

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.CallLog
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.smsgateway.specs.NativeSmsGatewaySpec

/**
 * The TurboModule: the whole of the JS <-> Android boundary.
 *
 * It extends `NativeSmsGatewaySpec`, which codegen generates from
 * `specs/NativeSmsGateway.ts`. That inheritance is the point - if the TypeScript
 * and the Kotlin ever disagree about a signature, the Android build fails. The
 * alternative (a hand-written bridge) fails instead on a user's phone, at
 * runtime, as `undefined is not a function`.
 *
 * Results are reported as EVENTS, not as promise resolutions, and that asymmetry
 * is deliberate rather than lazy: `sendSms` resolving tells you only that Android
 * took the message off your hands. Whether it left the radio is decided minutes
 * later by a broadcast (see SmsSender). Modelling that as a promise would force a
 * lie - either resolve early and call a possible failure "success", or hold the
 * promise open for minutes and hang the JS caller. Events match the shape of what
 * actually happens.
 */
class SmsGatewayModule(private val reactContext: ReactApplicationContext) :
    NativeSmsGatewaySpec(reactContext) {

    companion object {
        const val NAME = "SmsGateway"

        /** Event names. The TypeScript side subscribes to exactly these strings. */
        private const val EVENT_SENT = "sms.sent"
        private const val EVENT_FAILED = "sms.failed"
        private const val EVENT_DELIVERED = "sms.delivered"

        // The native connection reports its progress to the UI through these. They
        // are best-effort: when the JS runtime is frozen (the whole reason the
        // connection is native), emitting is a no-op and the UI simply catches up
        // when the app is next in the foreground.
        private const val EVENT_GW_STATUS = "gateway.status"
        private const val EVENT_GW_LOG = "gateway.log"
        private const val EVENT_GW_SENDING = "gateway.sending"
    }

    override fun getName(): String = NAME

    /** Turns a send outcome into a JS event, so the UI's history/counters update (when it is awake). */
    private val smsEventCallback = object : SmsSender.Callback {
        override fun onSent(messageId: String) {
            emit(EVENT_SENT, Arguments.createMap().apply { putString("messageId", messageId) })
        }

        override fun onFailed(messageId: String, errorCode: String, errorMessage: String) {
            emit(
                EVENT_FAILED,
                Arguments.createMap().apply {
                    putString("messageId", messageId)
                    putString("errorCode", errorCode)
                    putString("errorMessage", errorMessage)
                },
            )
        }

        override fun onDelivered(messageId: String) {
            emit(EVENT_DELIVERED, Arguments.createMap().apply { putString("messageId", messageId) })
        }
    }

    /** The bridge from the native connection's progress to JS device events for the UI. */
    private val statusSink = object : GatewayConnection.StatusSink {
        override fun onStatus(state: String, detail: String?, gatewayId: String?) {
            emit(
                EVENT_GW_STATUS,
                Arguments.createMap().apply {
                    putString("state", state)
                    if (detail != null) putString("detail", detail) else putNull("detail")
                    if (gatewayId != null) putString("gatewayId", gatewayId) else putNull("gatewayId")
                },
            )
        }

        override fun onLog(level: String, text: String) {
            emit(
                EVENT_GW_LOG,
                Arguments.createMap().apply {
                    putString("level", level)
                    putString("text", text)
                },
            )
        }

        override fun onSending(messageId: String, to: String, body: String, from: String?) {
            emit(
                EVENT_GW_SENDING,
                Arguments.createMap().apply {
                    putString("messageId", messageId)
                    putString("to", to)
                    putString("body", body)
                    if (from != null) putString("from", from) else putNull("from")
                },
            )
        }
    }

    init {
        // addCallback, not setCallback: the native GatewayConnection registers its
        // OWN SmsSender callback (to put results on the socket), and the two must
        // coexist. setCallback would clobber whichever registered first.
        SmsSender.addCallback(smsEventCallback)
        SmsSender.register(reactContext)
        GatewayConnection.setSink(statusSink)
    }

    private fun emit(event: String, params: WritableMap) {
        // The JS context can be gone (app killed, reload in dev) while a broadcast
        // is still in flight. Emitting into a dead context throws, and it would
        // throw on a background thread inside a BroadcastReceiver - taking the
        // whole process down rather than dropping one event.
        if (!reactContext.hasActiveReactInstance()) return

        runCatching {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        }
    }

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------

    /**
     * @param subscriptionId which SIM to send from. -1 means the phone's default.
     */
    override fun sendSms(
        messageId: String,
        recipient: String,
        body: String,
        subscriptionId: Double,
        promise: Promise,
    ) {
        if (!hasPermission(Manifest.permission.SEND_SMS)) {
            // Rejecting here rather than emitting `sms.failed` is deliberate: this
            // is a *synchronous* precondition failure. The message never reached
            // the radio, so there is no asynchronous outcome coming, and the JS
            // caller should learn about it on the call it just made.
            promise.reject("PERMISSION_DENIED", "SEND_SMS has not been granted")
            return
        }

        try {
            // Doubles, because that is the only number type the JS bridge has. An
            // Android subscription id is a small int, so the conversion is exact -
            // but it must be explicit, or Kotlin quietly compares a Double to an Int
            // and every SIM lookup misses.
            SmsSender.send(reactContext, messageId, recipient, body, subscriptionId.toInt())
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("SEND_FAILED", error.message ?: "SmsManager refused the message", error)
        }
    }

    /**
     * Every SIM currently in this handset.
     *
     * This is what makes a dual-SIM phone worth two gateways instead of one. The
     * `subscriptionId` of each entry is the handle that `sendSms` needs in order
     * to send from that specific SIM rather than from whichever one the user
     * happens to have set as default.
     *
     * `number` is almost always null - carriers rarely write the MSISDN to the SIM
     * - so the app asks the operator to label each slot by hand. That label is
     * matched back to the SIM by `subscriptionId`, never by the number, because
     * the number is a human-supplied string and the subscription id is the real
     * identity.
     */
    override fun getSimCards(promise: Promise) {
        val sims = Arguments.createArray()

        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) {
            // Not an error - just nothing we are allowed to see. Returning an empty
            // list lets the UI say "grant the permission" instead of crashing.
            promise.resolve(Arguments.createMap().apply { putArray("sims", sims) })
            return
        }

        try {
            val manager = reactContext.getSystemService(SubscriptionManager::class.java)
            val active = manager?.activeSubscriptionInfoList.orEmpty()

            for (info in active) {
                sims.pushMap(
                    Arguments.createMap().apply {
                        putInt("subscriptionId", info.subscriptionId)
                        // 0-based in the API, but every phone's UI calls them SIM 1
                        // and SIM 2. Present what the user sees on their own screen.
                        putInt("slot", info.simSlotIndex + 1)
                        putString("carrier", info.carrierName?.toString() ?: "Unknown")

                        val number = info.number?.takeIf { it.isNotBlank() }
                        if (number != null) putString("number", number) else putNull("number")
                    },
                )
            }

            promise.resolve(Arguments.createMap().apply { putArray("sims", sims) })
        } catch (error: SecurityException) {
            // Some OEMs (Oppo/Xiaomi among them) deny this even with the permission
            // granted. Degrade to "no SIMs visible" rather than taking the app down.
            promise.resolve(Arguments.createMap().apply { putArray("sims", sims) })
        }
    }

    // -----------------------------------------------------------------------
    // Device state
    // -----------------------------------------------------------------------

    override fun getDeviceInfo(promise: Promise) {
        try {
            val info = Arguments.createMap().apply {
                putString("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                putString("androidVersion", Build.VERSION.RELEASE)
                putInt("batteryLevel", batteryLevel())
                putBoolean("isCharging", isCharging())
                putBoolean("canSendSms", canSendSmsNow())

                val telephony = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager

                // simOperatorName is "" (not null) when there is no SIM. Passing an
                // empty string up would render as a blank operator in the dashboard
                // rather than an honest "unknown".
                val operator = telephony?.simOperatorName?.takeIf { it.isNotBlank() }
                if (operator != null) putString("simOperator", operator) else putNull("simOperator")

                val number = simPhoneNumber(telephony)
                if (number != null) putString("phoneNumber", number) else putNull("phoneNumber")
            }

            promise.resolve(info)
        } catch (error: Exception) {
            promise.reject("DEVICE_INFO_FAILED", error.message, error)
        }
    }

    override fun canSendSms(promise: Promise) {
        promise.resolve(canSendSmsNow())
    }

    /**
     * Can this handset actually put a message on the radio *right now*?
     *
     * Both halves matter. The permission can be revoked from Settings at any time,
     * while the app is running. And a phone with no SIM - or a SIM still booting -
     * has the permission but nowhere to send from. Reporting ONLINE in either case
     * makes the server dispatch messages that are all guaranteed to fail; reporting
     * DEGRADED makes it skip this device and say why.
     */
    private fun canSendSmsNow(): Boolean {
        if (!hasPermission(Manifest.permission.SEND_SMS)) return false

        val telephony = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
            ?: return false

        return telephony.simState == TelephonyManager.SIM_STATE_READY
    }

    /**
     * The SIM's own number — which Android will usually refuse to tell you.
     *
     * Do not be surprised when this returns null. The number is not stored on the
     * handset: it lives in the carrier's HLR, and only *some* carriers write it
     * into the SIM's MSISDN field. Most Indian networks do not. On top of that,
     * `getLine1Number()` was deprecated in API 33 and now needs the (privileged)
     * READ_PHONE_NUMBERS permission, and returns "" rather than null when it does
     * not know — which would render in the UI as a blank "From:" if we passed it
     * through.
     *
     * So: try, accept failure quietly, and let the operator type the number in.
     * That manual value is what the app actually ships to the server, and it is
     * why `senderNumber` is documented server-side as a label, not an identity.
     */
    @Suppress("DEPRECATION")
    private fun simPhoneNumber(telephony: TelephonyManager?): String? {
        val allowed = hasPermission(Manifest.permission.READ_PHONE_STATE) ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                hasPermission(Manifest.permission.READ_PHONE_NUMBERS))

        if (!allowed) return null

        return try {
            // A SecurityException here is normal, not exceptional: an OEM can deny
            // this even when the permission is granted. Letting it escape would
            // fail the whole getDeviceInfo() call and take the heartbeat down with
            // it - over a field we already expect not to have.
            telephony?.line1Number?.takeIf { it.isNotBlank() }
        } catch (_: SecurityException) {
            null
        }
    }

    private fun hasPermission(permission: String): Boolean =
        reactContext.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun batteryLevel(): Int {
        val status: Intent? = reactContext.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED),
        )

        val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1

        // The battery is reported as level-out-of-scale, and scale is NOT always
        // 100 - some devices report out of 1000. Hard-coding a percentage is a
        // real, shipped bug on those handsets.
        if (level < 0 || scale <= 0) return -1

        return (level * 100 / scale)
    }

    private fun isCharging(): Boolean {
        val status: Intent? = reactContext.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED),
        )

        val plugged = status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        return plugged != 0
    }

    // -----------------------------------------------------------------------
    // Call log & SMS (owner monitoring, read on demand)
    // -----------------------------------------------------------------------

    /**
     * This phone's recent call log, newest first.
     *
     * Returns `{ granted, entries: [{ number, name, direction, timestamp, durationSec }] }`.
     * `granted` is false - not an error - when the operator has not given the app
     * READ_CALL_LOG; the caller shows that state rather than an empty list. Read
     * straight from the CallLog content provider; nothing is stored.
     */
    override fun getCallLog(limit: Double, promise: Promise) {
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) {
            promise.resolve(Arguments.createMap().apply {
                putBoolean("granted", false)
                putArray("entries", Arguments.createArray())
            })
            return
        }

        val entries = Arguments.createArray()
        val max = limit.toInt().coerceIn(1, 300)

        try {
            reactContext.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.DATE,
                    CallLog.Calls.DURATION,
                ),
                null,
                null,
                "${CallLog.Calls.DATE} DESC",
            )?.use { cursor ->
                val numberIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                val nameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
                val typeIdx = cursor.getColumnIndex(CallLog.Calls.TYPE)
                val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)
                val durIdx = cursor.getColumnIndex(CallLog.Calls.DURATION)

                var count = 0
                while (cursor.moveToNext() && count < max) {
                    entries.pushMap(Arguments.createMap().apply {
                        val number = cursor.getString(numberIdx)
                        if (number.isNullOrBlank()) putNull("number") else putString("number", number)
                        val name = cursor.getString(nameIdx)
                        if (name.isNullOrBlank()) putNull("name") else putString("name", name)
                        putString("direction", callDirection(cursor.getInt(typeIdx)))
                        putDouble("timestamp", cursor.getLong(dateIdx).toDouble())
                        putInt("durationSec", cursor.getInt(durIdx))
                    })
                    count += 1
                }
            }

            promise.resolve(Arguments.createMap().apply {
                putBoolean("granted", true)
                putArray("entries", entries)
            })
        } catch (error: Exception) {
            promise.reject("CALL_LOG_FAILED", error.message ?: "Could not read the call log", error)
        }
    }

    /**
     * This phone's stored SMS, newest first, inbox and sent.
     *
     * Returns `{ granted, messages: [{ address, body, box, timestamp }] }`. Bodies
     * are capped so a burst of long multipart messages cannot blow past the socket
     * frame limit. `granted` false = READ_SMS not given.
     */
    override fun getDeviceSms(limit: Double, promise: Promise) {
        if (!hasPermission(Manifest.permission.READ_SMS)) {
            promise.resolve(Arguments.createMap().apply {
                putBoolean("granted", false)
                putArray("messages", Arguments.createArray())
            })
            return
        }

        val messages = Arguments.createArray()
        val max = limit.toInt().coerceIn(1, 200)

        try {
            reactContext.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(
                    Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY,
                    Telephony.Sms.DATE,
                    Telephony.Sms.TYPE,
                ),
                null,
                null,
                "${Telephony.Sms.DATE} DESC",
            )?.use { cursor ->
                val addrIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
                val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)
                val typeIdx = cursor.getColumnIndex(Telephony.Sms.TYPE)

                var count = 0
                while (cursor.moveToNext() && count < max) {
                    messages.pushMap(Arguments.createMap().apply {
                        val address = cursor.getString(addrIdx)
                        if (address.isNullOrBlank()) putNull("address") else putString("address", address)
                        putString("body", (cursor.getString(bodyIdx) ?: "").take(500))
                        putString("box", smsBox(cursor.getInt(typeIdx)))
                        putDouble("timestamp", cursor.getLong(dateIdx).toDouble())
                    })
                    count += 1
                }
            }

            promise.resolve(Arguments.createMap().apply {
                putBoolean("granted", true)
                putArray("messages", messages)
            })
        } catch (error: Exception) {
            promise.reject("SMS_READ_FAILED", error.message ?: "Could not read messages", error)
        }
    }

    private fun callDirection(type: Int): String = when (type) {
        CallLog.Calls.INCOMING_TYPE -> "incoming"
        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
        CallLog.Calls.MISSED_TYPE -> "missed"
        CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
        CallLog.Calls.REJECTED_TYPE -> "rejected"
        CallLog.Calls.BLOCKED_TYPE -> "blocked"
        else -> "unknown"
    }

    private fun smsBox(type: Int): String = when (type) {
        Telephony.Sms.MESSAGE_TYPE_INBOX -> "inbox"
        Telephony.Sms.MESSAGE_TYPE_SENT -> "sent"
        Telephony.Sms.MESSAGE_TYPE_DRAFT -> "draft"
        Telephony.Sms.MESSAGE_TYPE_OUTBOX -> "outbox"
        Telephony.Sms.MESSAGE_TYPE_FAILED -> "failed"
        Telephony.Sms.MESSAGE_TYPE_QUEUED -> "queued"
        else -> "unknown"
    }

    // -----------------------------------------------------------------------
    // The foreground service
    // -----------------------------------------------------------------------

    override fun startGateway(
        serverUrl: String,
        apiKey: String,
        deviceId: String,
        deviceName: String,
        simLabelsJson: String,
        heartbeatMs: Double,
    ) {
        val labels = mutableMapOf<String, String>()
        runCatching {
            val json = org.json.JSONObject(simLabelsJson)
            for (key in json.keys()) labels[key] = json.getString(key)
        }

        val config = GatewayConnection.Config(
            serverUrl = serverUrl,
            apiKey = apiKey,
            deviceId = deviceId,
            deviceName = deviceName,
            simLabels = labels,
            heartbeatMs = heartbeatMs.toLong(),
        )

        GatewayService.start(reactContext, config)
    }

    override fun startGatewayService(statusText: String) {
        // Legacy: the connection now comes up through startGateway(), which starts
        // the service AND the socket. A bare service with no connection is not a
        // useful state, so this is a no-op kept only so the codegen signature
        // resolves for any old caller.
        Log.i(NAME, "startGatewayService() is superseded by startGateway()")
    }

    override fun updateGatewayNotification(statusText: String) {
        GatewayService.update(reactContext, statusText)
    }

    override fun stopGatewayService() {
        GatewayService.stop(reactContext)
    }

    // -----------------------------------------------------------------------
    // Background survival
    // -----------------------------------------------------------------------

    /**
     * Is the process exempt from battery optimisation?
     *
     * When it is NOT, Doze and the OEM battery manager are free to freeze the
     * process once the screen is off - which stalls the WebSocket heartbeat, the
     * server reaps the device as dead, and it shows OFFLINE even though the
     * notification is still up. This is the check behind the app's "allow
     * background activity" prompt.
     */
    override fun isIgnoringBatteryOptimizations(promise: Promise) {
        val power = reactContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val ignoring = power?.isIgnoringBatteryOptimizations(reactContext.packageName) ?: false
        promise.resolve(ignoring)
    }

    /**
     * Launch the system "allow this app to run in the background?" dialog.
     *
     * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS shows a one-tap system prompt.
     * If the OEM has stripped it (some do), fall back to the battery-optimisation
     * list so the user can still find and exempt the app rather than hitting a dead
     * end. FLAG_ACTIVITY_NEW_TASK is required because a module has no Activity of
     * its own to launch from.
     */
    override fun requestDisableBatteryOptimization() {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${reactContext.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        try {
            reactContext.startActivity(direct)
        } catch (_: Exception) {
            openIgnoreBatteryList()
        }
    }

    private fun openIgnoreBatteryList() {
        runCatching {
            reactContext.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.onFailure { Log.w("SmsGateway", "Could not open battery optimisation settings", it) }
    }

    /**
     * Open this app's own settings page.
     *
     * The escape hatch for the OEM controls that have no public API - ColorOS/MIUI
     * "Auto-start" chief among them. We cannot toggle those from code (deliberately,
     * on the OEM's part), but we can drop the user one tap away from them.
     */
    override fun openAppSettings() {
        runCatching {
            reactContext.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:${reactContext.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.onFailure { Log.w("SmsGateway", "Could not open app settings", it) }
    }

    /**
     * Open the OEM "auto-start / protected apps" screen - whichever one this phone
     * has - so background execution is allowed on the vendors that gate it behind a
     * setting the standard battery-optimisation exemption does not touch.
     *
     * The battery-optimisation exemption is enough on Samsung and Pixel. Xiaomi,
     * Oppo/Realme, Vivo/iQOO, Huawei/Honor and OnePlus each add a vendor-specific
     * "auto-start" toggle with no public API, in a different Activity per brand. We
     * try each known screen in turn (the manifest <queries> block is what makes them
     * launchable on Android 11+), and fall back to this app's own settings page -
     * always present - when none exists or none is reachable.
     */
    override fun openAutoStartSettings() {
        val candidates = listOf(
            // Xiaomi / Redmi / POCO (MIUI)
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            // Oppo / Realme (ColorOS)
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            // Vivo / iQOO (Funtouch / OriginOS)
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            // Huawei / Honor (EMUI)
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            // OnePlus (OxygenOS)
            "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
        )

        for ((pkg, cls) in candidates) {
            val intent = Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // resolveActivity is non-null only because the manifest <queries> block
            // makes these packages visible; without it, Android 11+ would hide them.
            if (reactContext.packageManager.resolveActivity(intent, 0) != null) {
                try {
                    reactContext.startActivity(intent)
                    return
                } catch (_: Exception) {
                    // Non-exported, or a vendor quirk - fall through to the next one.
                }
            }
        }

        // No vendor auto-start screen (Samsung, Pixel, ...). The app's own settings
        // page is always present and reaches their equivalents.
        openAppSettings()
    }

    override fun invalidate() {
        // Remove only OUR listeners. The native connection keeps its own SmsSender
        // callback and keeps running - it must outlive this module, which is torn
        // down and recreated across JS reloads while the gateway stays connected.
        SmsSender.removeCallback(smsEventCallback)
        GatewayConnection.setSink(null)
        super.invalidate()
    }
}
