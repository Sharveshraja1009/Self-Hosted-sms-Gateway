import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MessageStatus } from './types';

/**
 * The message history this phone actually sent.
 *
 * Distinct from the Activity log on purpose. The log is a stream of events for
 * debugging a connection ("reconnecting in 4s"), it is capped, and it dies with
 * the process. This is a *record*: one row per SMS, with who it went from, who it
 * went to, and what became of it — and it survives a restart, because "did that
 * OTP go out this morning?" is a question people ask hours later.
 *
 * It is deliberately the DEVICE's own record, not a mirror of the server's. The
 * phone is the thing that touched the radio, so its account of what it sent is
 * the primary one; it also means history still renders when the server is
 * unreachable, which is exactly when you most want to look at it.
 *
 * Persisted as a single JSON blob rather than a row per message. With a cap of a
 * few hundred entries that is a few tens of KB — one read at startup and one
 * write per status change, which is far cheaper than the multi-key bookkeeping a
 * "proper" schema would need. If this ever needs to hold tens of thousands of
 * messages, it wants SQLite, not a bigger blob.
 */

const KEY = 'gateway.history';

/** Old entries fall off the end. A phone running for months must not grow without bound. */
const MAX_ENTRIES = 300;

export interface HistoryEntry {
  /** The server's message id. Also the correlation key for the native SMS events. */
  id: string;
  /** The SIM this went out from. Null when the device could not determine its number. */
  from: string | null;
  /** E.164 recipient. */
  to: string;
  body: string;
  status: MessageStatus;
  /** When the phone was handed the message. */
  at: number;
  /** Set when the radio confirmed it left the handset. */
  sentAt: number | null;
  /** Set when the carrier confirmed it arrived. */
  deliveredAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Reads the whole history.
 *
 * Returns [] rather than throwing on corrupt data. A phone in the field that
 * cannot render its history because one byte of JSON went bad — and therefore
 * cannot send SMS either, since the same screen hosts the Start button — would be
 * a spectacularly bad trade.
 */
export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function persist(entries: HistoryEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // A failed write must not break sending. Losing a history row is annoying;
    // dropping the SMS it describes is not acceptable.
  }
}

/** Records a message the moment the phone is handed it. Newest first. */
export async function recordSend(params: {
  id: string;
  from: string | null;
  to: string;
  body: string;
}): Promise<HistoryEntry[]> {
  const existing = await loadHistory();

  const entry: HistoryEntry = {
    id: params.id,
    from: params.from,
    to: params.to,
    body: params.body,
    status: 'SENDING',
    at: Date.now(),
    sentAt: null,
    deliveredAt: null,
    errorCode: null,
    errorMessage: null,
  };

  // De-duplicate on id. The server re-dispatches a message on reconnect if it
  // never heard a result, so the same id can legitimately arrive twice - and two
  // rows for one SMS would make the history lie about how many were sent.
  const next = [entry, ...existing.filter((e) => e.id !== params.id)].slice(0, MAX_ENTRIES);

  await persist(next);
  return next;
}

/** Moves an entry to its outcome. A no-op if the id is unknown to us. */
export async function updateStatus(
  id: string,
  patch: { status: MessageStatus; errorCode?: string; errorMessage?: string },
): Promise<HistoryEntry[]> {
  const existing = await loadHistory();
  const now = Date.now();

  const next = existing.map((entry) => {
    if (entry.id !== id) return entry;

    return {
      ...entry,
      status: patch.status,
      sentAt: patch.status === 'SENT' ? now : entry.sentAt,
      // DELIVERED implies SENT. A delivery report can beat the sent-receipt on a
      // fast network, and an entry showing "delivered" with no sent time reads as
      // a bug even though nothing is wrong.
      ...(patch.status === 'DELIVERED'
        ? { deliveredAt: now, sentAt: entry.sentAt ?? now }
        : {}),
      errorCode: patch.errorCode ?? entry.errorCode,
      errorMessage: patch.errorMessage ?? entry.errorMessage,
    };
  });

  await persist(next);
  return next;
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
