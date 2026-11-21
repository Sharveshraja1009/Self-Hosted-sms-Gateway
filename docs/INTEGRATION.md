# Integrating the SMS Gateway into your app

This is the guide for making **your application send SMS through this gateway** —
OTPs, rent reminders, alerts. It is a normal HTTP API; call it from PHP, Node,
Python, or anything that can make an HTTPS request.

## The mental model (read this once)

Your app never talks to the phone. It talks to the **gateway server**, which
relays the message to whichever phone is connected:

```
Your app  ──HTTP POST /api/sms/send──►  Gateway server  ──WebSocket──►  Phone (SIM)  ──►  recipient
```

So three things must be true for a message to go out:

1. The **gateway server** is running and reachable from your app.
2. At least one **phone** (the app) is connected and shows **Online**.
3. Your app authenticates with an **API key** that has the `sms:send` scope.

If (1) is fine but (2) is not, the API still accepts your message (`202`) and
**queues** it — it sends automatically when a phone next connects. You do not have
to handle "no phone right now" as an error.

---

## Step 1 — Get an API key

In the admin panel (`http://<your-server>:4000/admin`) → **API keys** → create one
named e.g. `MyApp production`, scope **`sms:send`** (add `sms:read` if your app
will also poll delivery status). Copy the key — it is shown once.

Or via the API:

```bash
curl -X POST http://<your-server>:4000/api/auth/api-keys \
  -H "Authorization: Bearer <your admin access token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"MyApp production","scopes":["sms:send","sms:read"]}'
```

Keep the key **on your server**, never in a browser or mobile app — anyone holding
it can send SMS on your account.

---

## Step 2 — Send a message

**Endpoint**

```
POST http://<your-server>:4000/api/sms/send
```

**Headers**

| Header | Value |
| --- | --- |
| `X-Api-Key` | `sk_...` (your key) |
| `Content-Type` | `application/json` |

**Body**

| Field | Required | Notes |
| --- | --- | --- |
| `to` | yes | Recipient in **E.164** — a leading `+`, country code, no spaces. `+919876543210`. `9876543210` and `09876543210` are rejected. |
| `body` | yes | The message text. Up to 1600 chars. |
| `from` | no | Send from a **specific** number. Omit and the gateway auto-picks the least-busy SIM. Use it when a message must come from a number the recipient already knows (see OTP note below). |
| `clientRef` | no | Your own id for this message, echoed back. Use it to reconcile against your records. |

**Response — `202 Accepted`**

```json
{
  "success": true,
  "data": {
    "id": "f427976c-b2cf-47ea-b5b0-c0659ac9c488",
    "recipient": "+919876543210",
    "senderNumber": "+919000000001",
    "status": "SENDING",
    "partCount": 1,
    "isUnicode": false
  },
  "meta": { "dispatched": true }
}
```

- `202`, not `200` — accepted for delivery, not yet delivered. Save `data.id`.
- `meta.dispatched: true` = handed to a phone now. `false` = queued (no phone was
  connected); it will send when one connects.
- `partCount` is how many SMS the carrier will bill. A message with any non-GSM
  character (a curly quote, an emoji, Hindi text) flips `isUnicode` to true and the
  per-part limit drops from 160 characters to 70 — watch this if cost matters.

---

## Step 3 — Check what happened (optional)

The `202` only means *accepted*. To learn the real outcome, poll with the message
id (needs the `sms:read` scope):

```
GET http://<your-server>:4000/api/sms/{id}
```

`status` moves through: `QUEUED → SENDING → SENT → DELIVERED`, or `→ FAILED`.

- **SENT** — the SMS left the phone's SIM.
- **DELIVERED** — the carrier confirmed it reached the recipient. This is
  network-dependent and sometimes never arrives, so do not *require* DELIVERED —
  treat SENT as success and DELIVERED as a bonus confirmation.
- **FAILED** — `errorCode` says why (`NO_SERVICE`, `RADIO_OFF`, `DAILY_LIMIT_EXCEEDED`…).

For most apps: fire the send, store the `id`, and only poll if you need a receipt.

---

## Errors you should handle

Every error is `{ "success": false, "error": { "code", "message" } }`.

| HTTP | `code` | Meaning | What to do |
| --- | --- | --- | --- |
| 422 | `VALIDATION_ERROR` | `to` isn't E.164, or `body` is empty | Fix the input. Don't retry as-is. |
| 401 | `API_KEY_INVALID` | Key is wrong, revoked or expired | Check the key. |
| 403 | `INSUFFICIENT_ROLE` | Key lacks the `sms:send` scope | Mint a key with the right scope. |
| 429 | `DAILY_LIMIT_EXCEEDED` | Every eligible SIM has hit its daily cap | Back off; the cap resets at local midnight. This protects your numbers from being blocked — do not try to defeat it. |
| 503 | `NO_GATEWAY_AVAILABLE` | A pinned `from` number is offline / unknown | Check that phone; or drop `from` to auto-route. (Note: with **no** `from`, no phone online does NOT error — it queues.) |

A `202` followed later by a `FAILED` status is normal and not an HTTP error — it
means the radio rejected it (no signal, etc.). That's what Step 3 is for.

---

## Code examples

### PHP (cURL)

```php
<?php
function sendSms(string $to, string $body, ?string $from = null): array {
    $payload = ['to' => $to, 'body' => $body];
    if ($from !== null) $payload['from'] = $from;

    $ch = curl_init('http://YOUR_SERVER:4000/api/sms/send');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'X-Api-Key: sk_YOUR_KEY_HERE',
        ],
        CURLOPT_POSTFIELDS => json_encode($payload),
    ]);

    $response = curl_exec($ch);
    $status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $data = json_decode($response, true);
    if ($status !== 202 || empty($data['success'])) {
        throw new RuntimeException($data['error']['message'] ?? 'SMS send failed');
    }
    return $data['data']; // ['id' => ..., 'status' => ...]
}

// OTP example — pin the sender so the code always comes from the same number:
sendSms('+919876543210', 'Your MyApp OTP is 4821. Valid 5 minutes.', '+919000000001');
```

### Node.js

```js
async function sendSms(to, body, from) {
  const res = await fetch('http://YOUR_SERVER:4000/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.SMS_KEY },
    body: JSON.stringify(from ? { to, body, from } : { to, body }),
  });
  const data = await res.json();
  if (res.status !== 202 || !data.success) {
    throw new Error(data.error?.message ?? 'SMS send failed');
  }
  return data.data; // { id, status, partCount, ... }
}
```

### Python

```python
import requests

def send_sms(to, body, sender=None):
    payload = {"to": to, "body": body}
    if sender:
        payload["from"] = sender
    r = requests.post(
        "http://YOUR_SERVER:4000/api/sms/send",
        headers={"X-Api-Key": "sk_YOUR_KEY_HERE"},
        json=payload,
        timeout=10,
    )
    data = r.json()
    if r.status_code != 202 or not data.get("success"):
        raise RuntimeError(data.get("error", {}).get("message", "SMS send failed"))
    return data["data"]
```

### curl (for testing)

```bash
curl -X POST http://YOUR_SERVER:4000/api/sms/send \
  -H "X-Api-Key: sk_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"to":"+919876543210","body":"Hello from MyApp"}'
```

---

## Notes for OTPs specifically

OTPs are the most common use, and two things matter:

- **Pin the `from` number.** Send every OTP from the same number so it lands in the
  same conversation thread on the recipient's phone and looks consistent. Pass
  `from` with one of your labelled numbers.
- **Mind the daily cap.** Each SIM sends ~100 SMS/day before the gateway refuses
  (to keep the carrier from blocking it). If your OTP volume is high, spread it:
  leave `from` off so the gateway auto-balances across all your SIMs, and add more
  phones/SIMs as volume grows. At ~500/day across 8 numbers you have plenty of room.

## Production checklist

- Put the gateway server behind **HTTPS** if your app calls it over the internet
  (not just your LAN). Then use `https://` in the URLs above — the key travels in a
  header and must not go out in the clear.
- Store the API key in your app's server config/secrets, never in client code.
- Keep the gateway phones **plugged in** and connected; monitor them in the admin
  panel. A phone that goes offline stops being dispatched to (its queued messages
  move to the next available phone).
