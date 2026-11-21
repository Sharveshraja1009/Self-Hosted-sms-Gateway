# Environment Variables

Every variable is validated at boot by [`backend/src/config/env.ts`](../backend/src/config/env.ts).
If one is missing or malformed the process prints the offending keys and exits
non-zero — a misconfigured server never starts and never serves a half-broken API.

Copy `backend/.env.example` to `backend/.env` to get a working development set.

---

## Application

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `APP_NAME` | `sms-gateway` | no | Service name stamped on every log line. |
| `NODE_ENV` | `development` | no | `development` \| `test` \| `production`. Drives log format, HSTS, error verbosity. |
| `PORT` | `4000` | no | HTTP listen port. |
| `HOST` | `0.0.0.0` | no | Listen address. `0.0.0.0` inside containers. |
| `API_PREFIX` | `/api` | no | Prefix for all API routes. Must start with `/`. Health is *also* served at `/health` regardless. |
| `TRUST_PROXY` | `0` | no | Number of reverse proxies in front of the app. Set to `1` behind nginx/traefik, otherwise every client looks like the proxy and rate limiting collapses to a single bucket. Never set higher than your real hop count — that lets a client spoof `X-Forwarded-For`. |
| `CORS_ORIGINS` | `http://localhost:5173` | no | Comma-separated browser origins allowed to call the API. Requests with no `Origin` (Android app, cURL, server integrations) are always allowed — they are authenticated by JWT/API key, not by CORS. |
| `BODY_LIMIT` | `1mb` | no | Max accepted request body. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | no | How long each shutdown hook may take to drain before it is abandoned. |

## Logging

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | no | `error` \| `warn` \| `info` \| `http` \| `debug`. |
| `LOG_DIR` | `logs` | no | Directory for `error.log` and `combined.log` (rotated, 5 files). |
| `LOG_TO_FILE` | `true` | no | Set `false` in containers where the platform captures stdout. |

## Datastores

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `MONGODB_URI` | — | **yes** | MongoDB connection string. Must start with `mongodb://` or `mongodb+srv://`. Against the dev stack, include `?directConnection=true` — the container is a single-node replica set, and without the flag the driver tries to resolve a cluster topology it cannot reach from outside Docker. |
| `MONGODB_DB` | `smsgw` | no | Database name, deliberately *not* read from the URI path: it lets the test suite point at `smsgw_test` by overriding one variable, and a URI that forgets its database name fails loudly instead of silently writing into Mongo's default `test` database. |
| `REDIS_URL` | — | **yes** | Redis connection string. Backs BullMQ and the distributed rate limiter from Phase 4. |

There are no migrations to run. Indexes are declared in `src/infra/mongo.ts` and
created at boot by `ensureIndexes()`, which is idempotent — a fresh database is
correct the moment the server starts. The unique index on `users.email` is
load-bearing, not cosmetic: it is what makes two concurrent registrations for the
same address safe.

## Authentication

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `JWT_ACCESS_SECRET` | — | **yes** | ≥32 chars. Generate with `openssl rand -hex 32`. Production refuses to start if it still begins with `change_me`. |
| `JWT_REFRESH_SECRET` | — | **yes** | ≥32 chars, and **different** from the access secret — otherwise a stolen access token can be replayed as a refresh token. |
| `JWT_ACCESS_TTL` | `15m` | no | Short by design: a leaked access token expires quickly. |
| `JWT_REFRESH_TTL` | `30d` | no | Refresh tokens are revocable server-side, so a long life is safe. |
| `GATEWAY_JWT_TTL` | `30d` | no | Android device token. Long-lived because a phone may sit on a shelf. |
| `BCRYPT_ROUNDS` | `12` | no | Password hashing cost. 10–15. |

## Rate limiting

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `RATE_LIMIT_WINDOW_MS` | `60000` | no | Global window. |
| `RATE_LIMIT_MAX` | `120` | no | Requests per window per client. Auth (10 / 15 min) and send-SMS (30 / min) have their own tighter limiters. |

## SMS policy

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `TIMEZONE` | `UTC` | no | IANA zone (e.g. `Asia/Kolkata`) defining when "midnight" is for the daily quota reset. Validated against the ICU database at boot. |
| `DEFAULT_DAILY_SMS_LIMIT` | `100` | no | Per-user daily cap applied to new users; overridable per user. |
| `MESSAGE_MAX_ATTEMPTS` | `3` | no | Retries before a message is marked permanently failed. |

## Gateway (Android device)

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `HEARTBEAT_INTERVAL_MS` | `30000` | no | How often the phone must ping over the WebSocket. Sent to the device at login so the two ends never disagree. |
| `GATEWAY_OFFLINE_TIMEOUT_MS` | `90000` | no | Silence after which a device is declared offline and its queued work is re-dispatched. Keep it at ≥ 2–3× the heartbeat, or normal mobile-network jitter will flap the device offline. |

## OTP

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `OTP_LENGTH` | `6` | no | Digits in a generated code (4–8). |
| `OTP_TTL_SECONDS` | `300` | no | Validity window. |
| `OTP_MAX_ATTEMPTS` | `3` | no | Wrong guesses before the code is burned. |
