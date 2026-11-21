import { z } from 'zod';

/**
 * The gateway wire protocol.
 *
 * One JSON object per WebSocket frame, discriminated on `type`. The Android app
 * implements the mirror image of this file, so treat every change here as a
 * breaking API change: a phone in someone's drawer running last month's APK will
 * still be speaking the old dialect.
 *
 * Server -> device
 *   sms.send        dispatch a message to the SIM
 *   registered      acknowledge a `register`, hand back the gateway id
 *   heartbeat.ack   acknowledge a heartbeat
 *   error           something the device sent was rejected
 *
 * Device -> server
 *   register        identify this handset (first frame, always)
 *   heartbeat       "still here", plus telemetry
 *   sms.result      the radio accepted or rejected the message
 *   sms.delivered   the carrier returned a delivery report
 *
 * Everything inbound is validated with Zod before it is believed. The device is
 * an untrusted client on a phone we do not control - it might be running a
 * modified APK, and "it's our own app" is not an authorisation model.
 */

// ---------------------------------------------------------------------------
// Device -> server
// ---------------------------------------------------------------------------

/**
 * One SIM in a handset.
 *
 * `subscriptionId` is Android's own handle for the SIM and is the ONLY reliable
 * identity here. `phoneNumber` is a label an operator typed into the app, because
 * Android will not tell anyone their own number - it is how a human recognises
 * the SIM, and how the send API addresses it, but nothing authenticates it.
 */
const simSchema = z.object({
  subscriptionId: z.number().int(),
  /** 1 or 2, matching what the phone's own Settings screen shows. */
  slot: z.number().int().min(1).max(4),
  carrier: z.string().max(100).nullish(),
  phoneNumber: z.string().max(32).nullish(),
});

const telemetrySchema = z.object({
  batteryLevel: z.number().int().min(0).max(100).nullish(),
  isCharging: z.boolean().nullish(),
  simOperator: z.string().max(100).nullish(),
  phoneNumber: z.string().max(32).nullish(),
  androidVersion: z.string().max(32).nullish(),
  appVersion: z.string().max(32).nullish(),
  canSendSms: z.boolean().nullish(),
  /**
   * Every SIM the phone can see. A dual-SIM handset reports two, and is therefore
   * worth two numbers to the gateway rather than one.
   *
   * Optional so that an older APK - one sitting in a drawer, still speaking last
   * month's protocol - keeps working. Its absence means "one SIM, the default".
   */
  sims: z.array(simSchema).max(4).nullish(),
});

export const registerFrameSchema = telemetrySchema.extend({
  type: z.literal('register'),
  /** Stable per-install id, generated on the device. */
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().min(1).max(100),
});

export const heartbeatFrameSchema = telemetrySchema.extend({
  type: z.literal('heartbeat'),
});

export const smsResultFrameSchema = z.object({
  type: z.literal('sms.result'),
  messageId: z.string().min(1).max(64),
  status: z.enum(['SENT', 'FAILED']),
  /** From Android's SmsManager: NO_SERVICE, RADIO_OFF, GENERIC_FAILURE, NULL_PDU... */
  errorCode: z.string().max(64).nullish(),
  errorMessage: z.string().max(500).nullish(),
});

export const smsDeliveredFrameSchema = z.object({
  type: z.literal('sms.delivered'),
  messageId: z.string().min(1).max(64),
});

/**
 * The phone's reply to a call-log request. `requestId` echoes the request so the
 * server can match a reply to the HTTP call that is waiting for it. `granted` is
 * false when the operator has not given the app READ_CALL_LOG on that handset - a
 * refusal, not an error, and one the panel should explain rather than retry.
 */
const callLogEntrySchema = z.object({
  number: z.string().max(64).nullish(),
  name: z.string().max(120).nullish(),
  direction: z.enum(['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'unknown']),
  /** Epoch milliseconds. */
  timestamp: z.number().int(),
  durationSec: z.number().int().min(0),
});

export const callLogResponseFrameSchema = z.object({
  type: z.literal('calllog.response'),
  requestId: z.string().min(1).max(64),
  granted: z.boolean(),
  entries: z.array(callLogEntrySchema).max(300),
});

const deviceSmsEntrySchema = z.object({
  address: z.string().max(64).nullish(),
  body: z.string().max(1000),
  box: z.enum(['inbox', 'sent', 'draft', 'outbox', 'failed', 'queued', 'unknown']),
  timestamp: z.number().int(),
});

export const deviceSmsResponseFrameSchema = z.object({
  type: z.literal('deviceSms.response'),
  requestId: z.string().min(1).max(64),
  granted: z.boolean(),
  messages: z.array(deviceSmsEntrySchema).max(300),
});

export const inboundFrameSchema = z.discriminatedUnion('type', [
  registerFrameSchema,
  heartbeatFrameSchema,
  smsResultFrameSchema,
  smsDeliveredFrameSchema,
  callLogResponseFrameSchema,
  deviceSmsResponseFrameSchema,
]);

export type InboundFrame = z.infer<typeof inboundFrameSchema>;
export type RegisterFrame = z.infer<typeof registerFrameSchema>;
export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;
export type SmsResultFrame = z.infer<typeof smsResultFrameSchema>;
export type SmsDeliveredFrame = z.infer<typeof smsDeliveredFrameSchema>;
export type CallLogResponseFrame = z.infer<typeof callLogResponseFrameSchema>;
export type DeviceSmsResponseFrame = z.infer<typeof deviceSmsResponseFrameSchema>;

// ---------------------------------------------------------------------------
// Server -> device
// ---------------------------------------------------------------------------

export interface RegisteredFrame {
  type: 'registered';
  gatewayId: string;
  /** How often the device should heartbeat, in ms. The server owns this policy, not the app. */
  heartbeatIntervalMs: number;
}

export interface SmsSendFrame {
  type: 'sms.send';
  messageId: string;
  recipient: string;
  body: string;
  /**
   * WHICH SIM must send this. The server chose it, and the phone does not get a
   * vote: on a dual-SIM handset the alternative is Android's "default SMS SIM",
   * which is whatever the user last picked in Settings - so the message would go
   * out from an arbitrary one of two business numbers, and the `senderNumber` the
   * server recorded would be a lie.
   *
   * -1 means "use the default", which is only correct for a single-SIM phone.
   */
  subscriptionId: number;
  /**
   * Echoed back so the phone's own history can show "from -> to" without having
   * to re-derive its own number. It is the number the *server* believes that SIM
   * sends from, which is exactly the label the message will carry in the API - so
   * the two views cannot disagree.
   */
  senderNumber: string | null;
}

export interface HeartbeatAckFrame {
  type: 'heartbeat.ack';
  /** Server clock, so a device with a wrong system time can still log coherently. */
  serverTime: string;
}

export interface ErrorFrame {
  type: 'error';
  message: string;
  /** Present when the error concerns a specific message. */
  messageId?: string;
}

/** Ask the phone for its call log. It replies with a `calllog.response` carrying the same requestId. */
export interface CallLogRequestFrame {
  type: 'calllog.request';
  requestId: string;
  /** How many recent entries to return, newest first. */
  limit: number;
}

/** Ask the phone for its stored SMS. Replies with `deviceSms.response`, same requestId. */
export interface DeviceSmsRequestFrame {
  type: 'deviceSms.request';
  requestId: string;
  limit: number;
}

export type OutboundFrame =
  | RegisteredFrame
  | SmsSendFrame
  | HeartbeatAckFrame
  | ErrorFrame
  | CallLogRequestFrame
  | DeviceSmsRequestFrame;

/** Parses an untrusted frame. Returns null rather than throwing - a malformed frame is not an exception, it is Tuesday. */
export function parseInboundFrame(raw: string): InboundFrame | null {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = inboundFrameSchema.safeParse(json);
  return result.success ? result.data : null;
}
