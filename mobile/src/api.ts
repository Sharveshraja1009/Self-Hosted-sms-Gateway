import { type GatewayConfig, serverOrigin } from './config';

/**
 * The app's HTTP client for the backend.
 *
 * Only used by the built-in test panel. Note what this deliberately does NOT do:
 * it does not hand the message straight to `SmsManager`.
 *
 * That would be the easy thing, and it would test almost nothing. A local send
 * proves the radio works and nothing else. Posting to `/api/sms/send` makes the
 * message take the *entire real path* - HTTP, auth, the E.164 guard, persistence,
 * the dispatcher, the WebSocket, back down to this same handset, into
 * SmsManager, and then the sent/delivered receipts back up to the server. If any
 * link in that chain is broken, this test finds it. A direct send would sail past
 * all of them and tell you everything was fine.
 */

const E164 = /^\+[1-9]\d{7,14}$/;

export interface SendResponse {
  id: string;
  status: string;
  partCount: number;
  isUnicode: boolean;
  senderNumber: string | null;
  recipient: string;
  /** False when the server accepted the message but had no phone to give it to. */
  dispatched: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Cleans up what a human types, then holds it to the same E.164 rule the server does. */
export function normaliseNumber(input: string): string | null {
  const cleaned = input.replace(/[\s()-]/g, '');
  return E164.test(cleaned) ? cleaned : null;
}

export async function sendTestSms(
  config: GatewayConfig,
  to: string,
  body: string,
): Promise<SendResponse> {
  const response = await fetch(`${serverOrigin(config.serverUrl)}/api/sms/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The same key the WebSocket authenticates with. It needs the `sms:send`
      // scope on top of `gateway:connect` - a key minted only to connect a
      // handset cannot send, which is the whole point of scoping them.
      'X-Api-Key': config.apiKey,
    },
    body: JSON.stringify({ to, body }),
  });

  const payload = (await response.json()) as {
    success: boolean;
    data?: SendResponse;
    meta?: { dispatched?: boolean };
    error?: { code: string; message: string };
  };

  if (!response.ok || !payload.success || !payload.data) {
    const code = payload.error?.code ?? `HTTP_${response.status}`;

    // Translate the two failures a user can actually act on. "FORBIDDEN" on its
    // own sends someone hunting through server logs; naming the missing scope
    // tells them exactly which key to re-mint.
    if (response.status === 403) {
      throw new ApiError('This API key lacks the sms:send scope. Mint a new key with it.', code);
    }
    if (response.status === 401) {
      throw new ApiError('The server rejected this API key.', code);
    }

    throw new ApiError(payload.error?.message ?? `Request failed (${response.status})`, code);
  }

  return { ...payload.data, dispatched: payload.meta?.dispatched ?? false };
}
