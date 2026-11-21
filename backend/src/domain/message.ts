/**
 * Messages - the thing this whole system exists to move.
 *
 * A Message row is append-mostly: it records what happened and when. We add a
 * timestamp as it progresses rather than overwriting one "statusChangedAt"
 * field, because during an incident the question is never "what is the status?"
 * - it is "the message sat QUEUED for 40 minutes and then SENT in 200ms; why?"
 * You cannot answer that from a single mutable column.
 */

export const MessageStatus = {
  /** Accepted by the API, waiting for a gateway. The only status a sender sees synchronously. */
  QUEUED: 'QUEUED',
  /** Handed to a specific device over the WebSocket. In flight. */
  SENDING: 'SENDING',
  /** The device's SmsManager reported the SMS left the radio. */
  SENT: 'SENT',
  /** The carrier returned a delivery report. The strongest guarantee we can offer. */
  DELIVERED: 'DELIVERED',
  /** Terminal failure. */
  FAILED: 'FAILED',
  /** Cancelled by a user before it was sent. */
  CANCELLED: 'CANCELLED',
} as const;

export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

/** Statuses from which nothing further will happen. A device report must not move a message out of one. */
export const TERMINAL_STATUSES: readonly MessageStatus[] = [
  MessageStatus.DELIVERED,
  MessageStatus.FAILED,
  MessageStatus.CANCELLED,
];

export interface Message {
  id: string;
  userId: string;
  /** Null until the dispatcher picks a device. */
  gatewayId: string | null;

  /** E.164, e.g. +919876543210. Normalised at the API boundary. */
  recipient: string;

  /**
   * The number this message went OUT from - the SIM in the phone that sent it.
   *
   * Null until a device is picked, and often null forever: Android usually cannot
   * tell you your own number (carriers rarely write the MSISDN to the SIM), so
   * this is whatever the gateway reported, which may be a value its operator
   * typed in by hand. Treat it as a label, never as an identity - it is not
   * verified by anything, and a device could report any string it likes.
   */
  senderNumber: string | null;

  /**
   * WHICH SIM carried it, as the pair that actually identifies a line: the phone
   * and the subscription on it.
   *
   * `senderNumber` above is a hand-typed label - it can be blank, wrong, or the
   * same string on two different handsets - so it cannot be the key the daily
   * per-SIM counters are computed from. These two can: they are what the quota is
   * spent against and what failover excludes. Null on a message that never
   * reached a device, and on rows written before this field existed.
   */
  senderDeviceId: string | null;
  senderSubscriptionId: number | null;

  body: string;

  status: MessageStatus;

  /** Carriers bill per part, so we record what we are about to be charged for. */
  partCount: number;
  isUnicode: boolean;

  attempts: number;

  /**
   * The SIMs this message has already been dispatched to, as `deviceId:subscriptionId`.
   *
   * This is what makes SIM failover safe: when one SIM's radio reports the send
   * FAILED, we re-route to a line NOT in this set, so a message never bounces back
   * onto the SIM that just rejected it. Grows by one entry per dispatch attempt.
   */
  triedLines: string[];

  /**
   * The number the caller pinned this message to (`from`), or null for a balanced
   * send. Failover is disabled when this is set: a pinned message must come from
   * that exact number (an OTP the customer already has in their contacts), so
   * silently retrying it on a different SIM would defeat the pin.
   */
  pinnedFrom: string | null;

  /** A machine-readable failure from the device: NO_SERVICE, RADIO_OFF, GENERIC_FAILURE... */
  errorCode: string | null;
  errorMessage: string | null;

  /** The caller's own id, for reconciliation against their system. */
  clientRef: string | null;

  // The lifecycle, as separate timestamps.
  queuedAt: Date;
  dispatchedAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface PublicMessage {
  id: string;
  /** Who it went to. */
  recipient: string;
  /** Which SIM it went from. Null when the device could not determine its own number. */
  senderNumber: string | null;
  body: string;
  status: MessageStatus;
  gatewayId: string | null;
  partCount: number;
  isUnicode: boolean;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  clientRef: string | null;
  queuedAt: string;
  dispatchedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
}

export function toPublicMessage(message: Message): PublicMessage {
  return {
    id: message.id,
    recipient: message.recipient,
    senderNumber: message.senderNumber,
    body: message.body,
    status: message.status,
    gatewayId: message.gatewayId,
    partCount: message.partCount,
    isUnicode: message.isUnicode,
    attempts: message.attempts,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
    clientRef: message.clientRef,
    queuedAt: message.queuedAt.toISOString(),
    dispatchedAt: message.dispatchedAt?.toISOString() ?? null,
    sentAt: message.sentAt?.toISOString() ?? null,
    deliveredAt: message.deliveredAt?.toISOString() ?? null,
    failedAt: message.failedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// SMS segmentation
// ---------------------------------------------------------------------------

/**
 * The GSM 03.38 basic character set.
 *
 * If every character of a message is in here, the radio encodes it as GSM-7 and
 * fits 160 characters into one part. One character outside it - a curly
 * apostrophe pasted from Word, an emoji, a Devanagari letter - forces the whole
 * message to UCS-2, and the limit collapses from 160 to 70.
 *
 * That cliff is why we compute this server-side and store it. "Why was I billed
 * for 3 SMS when I sent 90 characters?" is a support ticket you will get, and
 * the answer is almost always a single smart quote.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** These cost TWO GSM-7 septets: they are sent as an escape byte plus the character. */
const GSM7_EXTENDED = '\f^{}\\[~]|€';

const GSM7_SINGLE = new Set(GSM7_BASIC);
const GSM7_ESCAPED = new Set(GSM7_EXTENDED);

export interface Segmentation {
  partCount: number;
  isUnicode: boolean;
  /** GSM-7 septets, or UTF-16 code units for UCS-2. What the radio actually counts. */
  encodedLength: number;
}

/**
 * How many SMS parts will the radio split this into, and in which encoding?
 *
 * The concatenation headers are the subtle part: a multipart SMS spends 6 of its
 * 140 bytes on a UDH that says "part 2 of 3", so the per-part budget *drops* once
 * you cross the single-part boundary - 160 -> 153 for GSM-7, 70 -> 67 for UCS-2.
 * A naive `ceil(length / 160)` under-counts every long message, and you find out
 * from the carrier bill.
 */
export function segment(body: string): Segmentation {
  // Astral characters (emoji) are surrogate pairs: two UTF-16 code units, and the
  // radio counts code units, not codepoints. `body.length` is therefore already
  // the right measure for UCS-2 - iterating codepoints would UNDER-count.
  let septets = 0;
  let isUnicode = false;

  for (const char of body) {
    if (GSM7_SINGLE.has(char)) {
      septets += 1;
    } else if (GSM7_ESCAPED.has(char)) {
      septets += 2;
    } else {
      isUnicode = true;
      break;
    }
  }

  if (isUnicode) {
    const units = body.length;
    return {
      isUnicode: true,
      encodedLength: units,
      partCount: units === 0 ? 1 : units <= 70 ? 1 : Math.ceil(units / 67),
    };
  }

  return {
    isUnicode: false,
    encodedLength: septets,
    partCount: septets === 0 ? 1 : septets <= 160 ? 1 : Math.ceil(septets / 153),
  };
}
