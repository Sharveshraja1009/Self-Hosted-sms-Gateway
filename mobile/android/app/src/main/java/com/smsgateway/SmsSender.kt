package com.smsgateway

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.telephony.SmsManager
import android.util.Log

/**
 * The SMS modem.
 *
 * This is the only class in the project that touches the radio, and almost all of
 * its complexity comes from one fact people get wrong constantly:
 *
 *     SmsManager.sendTextMessage() is FIRE AND FORGET.
 *
 * It returns void, immediately, whether or not the message will ever leave the
 * phone. There is no return value to check and no exception on failure. The
 * outcome arrives *later* - possibly minutes later, if the radio is busy or out
 * of signal - as a broadcast to a PendingIntent you supplied up front. If you do
 * not supply one, the message failing is simply something you never find out
 * about. A gateway that cannot tell the difference between "sent" and "silently
 * dropped" is worse than no gateway at all, because it lies to its callers.
 *
 * So every send registers two receivers:
 *
 *   SENT      - the radio accepted (or rejected) the message. Carries the failure
 *               reason, which is the only diagnostic we will ever get.
 *   DELIVERED - the carrier says the handset received it. Optional, network
 *               dependent, and frequently never arrives at all. Its absence proves
 *               nothing, which is why SENT and DELIVERED are different statuses
 *               all the way up the stack rather than one boolean.
 *
 * Multipart is the other trap. A message over 160 GSM-7 characters (70 Unicode) is
 * split by the radio into parts, and you get one broadcast PER PART. Reporting the
 * first one as "the" result would mark a 3-part message SENT when parts 2 and 3
 * failed. We therefore count parts down and only report success when every one of
 * them has landed - and report the FIRST failure immediately, because one failed
 * part means the recipient gets a corrupted half-message.
 */
object SmsSender {

    private const val TAG = "SmsSender"

    private const val ACTION_SENT = "com.smsgateway.SMS_SENT"
    private const val ACTION_DELIVERED = "com.smsgateway.SMS_DELIVERED"
    private const val EXTRA_MESSAGE_ID = "messageId"

    /** What the caller learns about a send, asynchronously. */
    interface Callback {
        fun onSent(messageId: String)
        fun onFailed(messageId: String, errorCode: String, errorMessage: String)
        fun onDelivered(messageId: String)
    }

    // A LIST, not a single slot: two independent listeners want send outcomes now -
    // the module (which emits JS events for the UI) and the native GatewayConnection
    // (which turns them into frames on the socket). Both must fire, and the native
    // one must keep firing even when JS is frozen. CopyOnWriteArrayList so a
    // broadcast receiver iterating callbacks can't race an add/remove.
    private val callbacks = java.util.concurrent.CopyOnWriteArrayList<Callback>()
    private var registered = false

    /** Per-message part bookkeeping. A multipart send is not done until every part reports. */
    private data class Pending(var remaining: Int, var settled: Boolean = false)

    private val pending = mutableMapOf<String, Pending>()

    fun addCallback(cb: Callback) {
        if (!callbacks.contains(cb)) callbacks.add(cb)
    }

    fun removeCallback(cb: Callback) {
        callbacks.remove(cb)
    }

    /** Backwards-compatible single-listener setter: replaces whatever was there. */
    fun setCallback(cb: Callback?) {
        callbacks.clear()
        if (cb != null) callbacks.add(cb)
    }

    private fun eachCallback(action: (Callback) -> Unit) {
        for (cb in callbacks) runCatching { action(cb) }
    }

    /**
     * Registers the two broadcast receivers. Idempotent; safe to call on every
     * service start.
     */
    @Synchronized
    fun register(context: Context) {
        if (registered) return

        val appContext = context.applicationContext

        // RECEIVER_NOT_EXPORTED: these broadcasts come from the system on our own
        // PendingIntents. Nothing else has any business sending them, and on
        // Android 14+ the flag is mandatory anyway.
        ContextCompat.registerReceiver(appContext, sentReceiver, IntentFilter(ACTION_SENT))
        ContextCompat.registerReceiver(appContext, deliveredReceiver, IntentFilter(ACTION_DELIVERED))

        registered = true
    }

    @Synchronized
    fun unregister(context: Context) {
        if (!registered) return

        val appContext = context.applicationContext
        runCatching { appContext.unregisterReceiver(sentReceiver) }
        runCatching { appContext.unregisterReceiver(deliveredReceiver) }

        registered = false
        pending.clear()
    }

    /**
     * Hands a message to the radio, from a SPECIFIC SIM.
     *
     * `subscriptionId` is the one parameter that makes a dual-SIM phone useful as
     * a gateway. Without it, `SmsManager` sends from whichever SIM the *user* has
     * set as their default in Settings - so a phone holding two business numbers
     * would send everything from one of them, and the "from" recorded by the
     * server would be a lie. Pass -1 to accept the default.
     *
     * Throws only for the synchronous failures (no SIM, no permission). Anything
     * asynchronous - no signal, radio off, carrier rejection - arrives via the
     * callback, which is the whole point of the receivers above.
     */
    fun send(context: Context, messageId: String, recipient: String, body: String, subscriptionId: Int) {
        val smsManager = smsManager(context, subscriptionId)

        // Let the platform decide the split: it knows the encoding rules better
        // than we do, and its answer is the one that will actually be billed.
        val parts = smsManager.divideMessage(body)
        val partCount = parts.size

        synchronized(pending) {
            pending[messageId] = Pending(remaining = partCount)
        }

        val sentIntents = ArrayList<PendingIntent>(partCount)
        val deliveredIntents = ArrayList<PendingIntent>(partCount)

        for (i in 0 until partCount) {
            sentIntents.add(pendingIntent(context, ACTION_SENT, messageId, i))
            deliveredIntents.add(pendingIntent(context, ACTION_DELIVERED, messageId, i))
        }

        Log.i(TAG, "Sending $messageId to $recipient in $partCount part(s)")

        // sendMultipartTextMessage handles the single-part case correctly too, so
        // there is no special-casing here. One code path, exercised every time.
        smsManager.sendMultipartTextMessage(recipient, null, parts, sentIntents, deliveredIntents)
    }

    /**
     * A PendingIntent per part, per message.
     *
     * The request code must be unique or Android will REUSE an existing
     * PendingIntent and quietly overwrite its extras - so every part of every
     * message would report under whichever messageId happened to be registered
     * first. That bug looks exactly like "delivery reports are randomly attributed
     * to the wrong message", and it is miserable to track down. Hashing the
     * message id with the part index keeps them distinct.
     *
     * FLAG_IMMUTABLE because we never modify the intent after creating it, and
     * Android 12+ requires one of IMMUTABLE/MUTABLE to be explicit.
     */
    private fun pendingIntent(context: Context, action: String, messageId: String, part: Int): PendingIntent {
        val intent = Intent(action).apply {
            putExtra(EXTRA_MESSAGE_ID, messageId)
            setPackage(context.packageName)
        }

        val requestCode = (messageId.hashCode() * 31 + part) and 0x7FFFFFFF

        return PendingIntent.getBroadcast(
            context.applicationContext,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private val sentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID) ?: return

            if (resultCode == android.app.Activity.RESULT_OK) {
                val done = synchronized(pending) {
                    val entry = pending[messageId] ?: return@synchronized false
                    if (entry.settled) return@synchronized false

                    entry.remaining -= 1
                    if (entry.remaining <= 0) {
                        entry.settled = true
                        pending.remove(messageId)
                        true
                    } else {
                        false
                    }
                }

                // Only when the LAST part has been accepted. Reporting on the first
                // would mark a 3-part message sent while parts 2 and 3 were still
                // in flight - or already failing.
                if (done) {
                    Log.i(TAG, "Sent $messageId")
                    eachCallback { it.onSent(messageId) }
                }
                return
            }

            // One part failed, so the whole message failed: the recipient would
            // otherwise get a truncated fragment. Settle it now and ignore the
            // remaining parts' broadcasts.
            val alreadySettled = synchronized(pending) {
                val entry = pending[messageId]
                if (entry == null || entry.settled) {
                    true
                } else {
                    entry.settled = true
                    pending.remove(messageId)
                    false
                }
            }

            if (alreadySettled) return

            val code = errorName(resultCode)
            Log.w(TAG, "Failed $messageId: $code")
            eachCallback { it.onFailed(messageId, code, errorDescription(resultCode)) }
        }
    }

    private val deliveredReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID) ?: return

            if (resultCode == android.app.Activity.RESULT_OK) {
                Log.i(TAG, "Delivered $messageId")
                eachCallback { it.onDelivered(messageId) }
            } else {
                // A delivery report can come back negative. That is not a send
                // failure - the SMS left the phone - so we do not touch the status.
                Log.w(TAG, "Delivery report for $messageId was not OK")
            }
        }
    }

    /**
     * Resolves the SmsManager for a given SIM.
     *
     * Binding a send to one specific SIM is what makes a dual-SIM phone useful as a
     * gateway - and the API to do it CHANGED at Android 12, in a way that is easy to
     * get wrong because the two method names look interchangeable but are not:
     *
     *  - **API 31+ (Android 12+):** the modern way is the *instance* method
     *    `context.getSystemService(SmsManager).createForSubscriptionId(id)`. The old
     *    static `SmsManager.getDefault()` was deprecated here.
     *
     *  - **API 22..30 (Android 5.1 - 11):** `createForSubscriptionId()` DOES NOT
     *    EXIST yet - calling it throws `NoSuchMethodError` ("No virtual method
     *    createForSubscriptionId"), which is exactly how this surfaced on an
     *    Android 11 handset. The method that works here is the *static*
     *    `SmsManager.getSmsManagerForSubscriptionId(id)`, deprecated only at 31.
     *
     * So the SIM-specific path forks on the version. A subscriptionId of -1 means
     * "caller does not care", and we fall back to the default subscription.
     */
    fun smsManager(context: Context, subscriptionId: Int = -1): SmsManager {
        // No specific SIM requested: use the platform default.
        if (subscriptionId < 0) {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }
        }

        // A specific SIM was requested. Use whichever binding exists on this version.
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java).createForSubscriptionId(subscriptionId)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
        }
    }

    /** The stable, machine-readable code the backend stores in `Message.errorCode`. */
    private fun errorName(resultCode: Int): String = when (resultCode) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
        SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
        SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "LIMIT_EXCEEDED"
        else -> "UNKNOWN_$resultCode"
    }

    private fun errorDescription(resultCode: Int): String = when (resultCode) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "The radio rejected the message"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "No cellular service"
        SmsManager.RESULT_ERROR_NULL_PDU -> "The message produced an empty PDU"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "The radio is off (flight mode?)"
        SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "The carrier rate limit was exceeded"
        else -> "Unknown SmsManager failure (code $resultCode)"
    }
}

/** Small shim so the RECEIVER_NOT_EXPORTED flag is applied only where it exists. */
private object ContextCompat {
    fun registerReceiver(context: Context, receiver: BroadcastReceiver, filter: IntentFilter) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
    }
}
