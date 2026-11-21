# API Reference

Base URL: `http://localhost:4000/api` (configurable via `API_PREFIX`).

## Response envelope

Every response — success or failure — has one of exactly two shapes.

**Success**

```json
{
  "success": true,
  "data": { },
  "meta": { },
  "requestId": "29ae53f8-84ec-461a-85df-44cbdff1495d"
}
```

**Failure**

```json
{
  "success": false,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "details": []
  },
  "requestId": "29ae53f8-84ec-461a-85df-44cbdff1495d"
}
```

Branch on `error.code`, not on the HTTP status. Status is too coarse: `RATE_LIMIT_EXCEEDED`
and `DAILY_LIMIT_EXCEEDED` are both `429` but mean very different things to a user.

`requestId` appears in the body **and** the `X-Request-Id` response header, and it is the
string to quote in a bug report — every log line for that request carries it.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | Body/query/params failed schema validation. `details` lists the offending fields. |
| `BAD_REQUEST` | 400 | Malformed JSON, oversized payload. |
| `UNAUTHORIZED` | 401 | No credential presented. |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password, or wrong current password. |
| `TOKEN_EXPIRED` | 401 | Access token past its 15-minute life. **Refresh and retry.** |
| `TOKEN_INVALID` | 401 | Forged, malformed, or already-used token. Re-authenticate. |
| `API_KEY_INVALID` | 401 | Unknown, revoked or expired API key. |
| `ACCOUNT_DISABLED` | 401 | The account (or the account owning the key) is deactivated. |
| `FORBIDDEN` | 403 | Authenticated, but not permitted. |
| `INSUFFICIENT_ROLE` | 403 | Role or API-key scope too narrow for this route. |
| `NOT_FOUND` | 404 | No such route or resource. |
| `ALREADY_EXISTS` | 409 | Email already registered. |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests. See `Retry-After`. |
| `INTERNAL_ERROR` | 500 | A bug. The message is suppressed in production. |

---

## Authentication

Two credential types. Both resolve to the same principal, so every endpoint accepts either.

**JWT (humans / the dashboard)** — 15-minute access token, obtained from login:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**API key (machines / the Android gateway / integrations)** — long-lived, revocable, scoped:

```http
X-Api-Key: sk_wFt3m33lgUGy7nDgv4U9RlY8w_DLpcgAYDEv6coxozs
```

An API key is also accepted as `Authorization: Bearer sk_...`, since the `sk_` prefix makes
it unambiguous.

### Scopes

| Scope | Grants |
| --- | --- |
| `sms:send` | Enqueue outbound messages. |
| `sms:read` | Read message history and statistics. |
| `gateway:connect` | Authenticate an Android device at `POST /api/gateway/login`. |

Scopes only constrain **API keys**. A JWT-authenticated human is governed by their role
(`ADMIN`, `USER`, `VIEWER`) — scopes exist to narrow a machine credential *below* its
owner's authority, never to widen it.

### Token lifecycle

The access token is a stateless JWT: fast to verify, but **not revocable** — so it lives
only 15 minutes. The refresh token is an opaque 256-bit random string, stored server-side
as a SHA-256 digest, and it **is** revocable — so it can safely live 30 days.

Refresh tokens **rotate**: each use spends the old token and returns a new one. Presenting
a spent token is treated as theft — the entire token family from that login is revoked and
the user must sign in again. This is intentional and it will log out the legitimate user
too; we cannot distinguish a replay by an attacker from a replay by a buggy client, so we
fail safe. **Never refresh twice concurrently with the same token.**

---

## Endpoints

### `POST /api/auth/register`

Public. Rate limited: 10 / 15 min / IP.

The **first account to register becomes `ADMIN`** — that is how the system bootstraps.
Every later account is a `USER`.

```json
{ "email": "admin@example.com", "password": "a-really-strong-passphrase", "name": "Site Admin" }
```

Password must be 10–72 characters. There are no composition rules — length is the only
requirement that survives contact with real users. (72 is bcrypt's hard truncation point.)

**`201`** → `{ user, tokens }`, identical in shape to login.

---

### `POST /api/auth/login`

Public. Rate limited: 10 / 15 min / IP (successful logins are not counted).

```json
{ "email": "admin@example.com", "password": "a-really-strong-passphrase" }
```

**`200`**

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "b07d1029-43ff-4600-bc90-342ca72609ca",
      "email": "admin@example.com",
      "name": "Site Admin",
      "role": "ADMIN",
      "isActive": true,
      "dailySmsLimit": 100,
      "lastLoginAt": null,
      "createdAt": "2026-07-11T05:57:25.444Z"
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIs...",
      "refreshToken": "1wC50iD3H4w-WSxVFzy9...",
      "tokenType": "Bearer",
      "expiresIn": 900
    }
  }
}
```

A wrong password and an unknown email return a **byte-for-byte identical** error, in the
same amount of time. The API is not an oracle for "does this account exist?".

---

### `POST /api/auth/refresh`

Public (the refresh token *is* the credential). Rate limited.

```json
{ "refreshToken": "1wC50iD3H4w-WSxVFzy9..." }
```

**`200`** → `{ user, tokens }` with a **new** refresh token. Discard the old one immediately.

**`401 TOKEN_INVALID`** → the token was already spent. Every session from that login has now
been revoked. Send the user back to the login screen.

---

### `POST /api/auth/logout`

Public, idempotent. Revokes the one session.

```json
{ "refreshToken": "..." }
```

Always **`200`**, even for a token that never existed — otherwise this endpoint would let
anyone probe which tokens are real.

---

### `POST /api/auth/logout-all`

Requires auth. Revokes every session for the caller — the "I lost my phone" button.

**`200`** → `{ "message": "...", "sessionsRevoked": 3 }`

---

### `GET /api/auth/me`

Requires auth (JWT or API key). Returns the current user.

---

### `POST /api/auth/change-password`

Requires auth.

```json
{ "currentPassword": "...", "newPassword": "..." }
```

The current password is required **even though you are already authenticated** — that stops
a stolen access token from being escalated into permanent account takeover. On success,
every session (including the caller's) is revoked.

**`200`** → `{ "message": "...", "sessionsRevoked": 2 }`

---

### `GET /api/auth/api-keys`

Requires auth. Lists the caller's keys. **Never returns the key itself** — only `keyPrefix`.

---

### `POST /api/auth/api-keys`

Requires auth.

```json
{
  "name": "Android Gateway - Samsung S23",
  "scopes": ["sms:send", "gateway:connect"],
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

`scopes` defaults to `["sms:send"]`. `expiresAt` is optional; omit for a key that never expires.

**`201`**

```json
{
  "id": "bf3a31c9-60ee-4129-8e1b-58f51fa2d68d",
  "name": "Android Gateway - Samsung S23",
  "keyPrefix": "sk_wFt3m33l",
  "scopes": ["sms:send", "gateway:connect"],
  "plaintext": "sk_wFt3m33lgUGy7nDgv4U9RlY8w_DLpcgAYDEv6coxozs",
  "warning": "Store this key now. It cannot be retrieved again."
}
```

> `plaintext` appears in this response and **nowhere else, ever**. Only a SHA-256 digest is
> stored, so we genuinely cannot recover it — not for you, not for an attacker with a
> database dump. Lose it and you issue a new one.

---

### `DELETE /api/auth/api-keys/:id`

Requires auth. Revokes the key immediately. You may only revoke keys you own.

---

## Health

Unauthenticated and never rate-limited — a throttled liveness probe is how a healthy
container gets killed.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. `200` while the event loop turns. Restart the container if this fails. |
| `GET /health/ready` | Readiness. `200` / `503` based on every registered dependency probe. Pull from the load balancer if this fails. |
| `GET /health/info` | Version, uptime, memory, timezone. |

Also served under the API prefix (`/api/health`), so infrastructure never needs to know
what `API_PREFIX` is set to.

---

## Rate limits

| Scope | Limit |
| --- | --- |
| Global (all `/api` routes) | 120 / min |
| `/auth/register`, `/auth/login`, `/auth/refresh` | 10 / 15 min per IP |
| `/messages/send` *(Phase 4)* | 30 / min per user |

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and — when
throttled — `Retry-After`.

---

## A note on CSRF

This API is Bearer-token authenticated and sets **no cookies**. A browser cannot be tricked
into attaching a credential to a cross-site request, because there is no ambient credential
to attach — so CSRF tokens would be pure ceremony. If refresh tokens ever move into cookies,
CSRF protection becomes mandatory and this section must change.
