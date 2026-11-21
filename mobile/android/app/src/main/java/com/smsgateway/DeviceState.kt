package com.smsgateway

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.provider.CallLog
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything the gateway needs to READ about this handset - battery, SIMs, the
 * call log, stored SMS - as plain data the native {@link GatewayConnection} can
 * drop straight into a protocol frame.
 *
 * This is the native mirror of the read paths in SmsGatewayModule, deliberately
 * kept separate: the module returns React Native `WritableMap`s for JavaScript,
 * while the connection needs `org.json` values it can serialise onto the socket
 * without a bridge. The two must agree on shape - the server does not care which
 * side produced a frame - so the field names here match the module's exactly.
 *
 * The reason this exists at all: when Android freezes the app's JavaScript in the
 * background, the module's JS-facing methods are unreachable, but the socket is
 * still open and the server may still ask this phone to send. The connection has
 * to answer from native code, which means reading device state from native code.
 */
object DeviceState {

    /** The device telemetry a register/heartbeat frame carries. `batteryLevel` is -1 when unknown. */
    data class Info(
        val deviceName: String,
        val androidVersion: String,
        val batteryLevel: Int,
        val isCharging: Boolean,
        val canSendSms: Boolean,
        val simOperator: String?,
        val phoneNumber: String?,
    )

    fun info(context: Context): Info {
        val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        val operator = telephony?.simOperatorName?.takeIf { it.isNotBlank() }

        return Info(
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            androidVersion = Build.VERSION.RELEASE ?: "",
            batteryLevel = batteryLevel(context),
            isCharging = isCharging(context),
            canSendSms = canSendSms(context),
            simOperator = operator,
            phoneNumber = simPhoneNumber(context, telephony),
        )
    }

    /**
     * The SIM list a register/heartbeat frame carries: `[{ subscriptionId, slot,
     * carrier, phoneNumber }]`. The operator's typed label (keyed by
     * subscriptionId) wins over whatever Android reports, because Android's number
     * is empty far more often than it is right.
     */
    fun simReport(context: Context, labels: Map<String, String>): JSONArray {
        val out = JSONArray()
        if (!hasPermission(context, Manifest.permission.READ_PHONE_STATE)) return out

        try {
            val manager = context.getSystemService(SubscriptionManager::class.java)
            val active = manager?.activeSubscriptionInfoList ?: emptyList()
            for (sub in active) {
                val subId = sub.subscriptionId
                val label = labels[subId.toString()]
                val number = label ?: sub.number?.takeIf { it.isNotBlank() }
                out.put(JSONObject().apply {
                    put("subscriptionId", subId)
                    put("slot", sub.simSlotIndex + 1)
                    put("carrier", sub.carrierName?.toString() ?: "Unknown")
                    put("phoneNumber", number ?: JSONObject.NULL)
                })
            }
        } catch (_: SecurityException) {
            // Some OEMs deny this even with the permission granted. An empty list is
            // the honest answer, not a crash.
        }
        return out
    }

    /** `{ granted, entries: [{ number, name, direction, timestamp, durationSec }] }`, newest first. */
    fun callLog(context: Context, limit: Int): JSONObject {
        if (!hasPermission(context, Manifest.permission.READ_CALL_LOG)) {
            return JSONObject().apply { put("granted", false); put("entries", JSONArray()) }
        }

        val entries = JSONArray()
        val max = limit.coerceIn(1, 300)

        try {
            context.contentResolver.query(
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
                    val number = cursor.getString(numberIdx)
                    val name = cursor.getString(nameIdx)
                    entries.put(JSONObject().apply {
                        put("number", if (number.isNullOrBlank()) JSONObject.NULL else number)
                        put("name", if (name.isNullOrBlank()) JSONObject.NULL else name)
                        put("direction", callDirection(cursor.getInt(typeIdx)))
                        put("timestamp", cursor.getLong(dateIdx).toDouble())
                        put("durationSec", cursor.getInt(durIdx))
                    })
                    count += 1
                }
            }
        } catch (_: Exception) {
            // Degrade to whatever we gathered rather than failing the whole request.
        }

        return JSONObject().apply { put("granted", true); put("entries", entries) }
    }

    /** `{ granted, messages: [{ address, body, box, timestamp }] }`, newest first. Bodies capped. */
    fun deviceSms(context: Context, limit: Int): JSONObject {
        if (!hasPermission(context, Manifest.permission.READ_SMS)) {
            return JSONObject().apply { put("granted", false); put("messages", JSONArray()) }
        }

        val messages = JSONArray()
        val max = limit.coerceIn(1, 200)

        try {
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
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
                    val address = cursor.getString(addrIdx)
                    messages.put(JSONObject().apply {
                        put("address", if (address.isNullOrBlank()) JSONObject.NULL else address)
                        put("body", (cursor.getString(bodyIdx) ?: "").take(500))
                        put("box", smsBox(cursor.getInt(typeIdx)))
                        put("timestamp", cursor.getLong(dateIdx).toDouble())
                    })
                    count += 1
                }
            }
        } catch (_: Exception) {
            // As above - partial data beats a failed request.
        }

        return JSONObject().apply { put("granted", true); put("messages", messages) }
    }

    // -----------------------------------------------------------------------
    // Internals (mirrors of SmsGatewayModule's private helpers)
    // -----------------------------------------------------------------------

    fun canSendSms(context: Context): Boolean {
        if (!hasPermission(context, Manifest.permission.SEND_SMS)) return false
        val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return false
        return telephony.simState == TelephonyManager.SIM_STATE_READY
    }

    private fun hasPermission(context: Context, permission: String): Boolean =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun batteryLevel(context: Context): Int {
        val status: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        if (level < 0 || scale <= 0) return -1
        return (level * 100 / scale)
    }

    private fun isCharging(context: Context): Boolean {
        val status: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        return plugged != 0
    }

    @Suppress("DEPRECATION")
    private fun simPhoneNumber(context: Context, telephony: TelephonyManager?): String? {
        val allowed = hasPermission(context, Manifest.permission.READ_PHONE_STATE) ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                hasPermission(context, Manifest.permission.READ_PHONE_NUMBERS))
        if (!allowed) return null
        return try {
            telephony?.line1Number?.takeIf { it.isNotBlank() }
        } catch (_: SecurityException) {
            null
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
}
