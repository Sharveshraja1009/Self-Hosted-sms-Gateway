# SMS Gateway

A self-hosted SMS gateway that turns an ordinary Android phone into the SMS modem.
No Twilio, no MSG91, no Vonage, no Firebase — messages leave through the phone's own
SIM card via Android's `SmsManager`, over the mobile network you already pay for.

```
Users → Dashboard → Node.js Backend → WebSocket → Android App → SmsManager → SIM → Recipient
```

The Node.js backend never touches a radio. It owns business logic — auth, quotas,
queueing, delivery tracking, audit — and hands each message to whichever Android
device is currently connected and healthy.

---

## Repository layout

| Directory   | What lives there                                                          |
| ----------- | ------------------------------------------------------------------------- |
| `backend/`  | Node.js 22 + TypeScript + Express API, MongoDB, WebSocket gateway server   |
| `mobile/`   | React Native gateway app — the SMS modem. TS for the logic, Kotlin for the radio |
| `backend/public/admin/` | Web admin panel (plain HTML, CSS and JavaScript) served by the backend |
| `docker/`   | Compose stack: MongoDB, Redis, mongo-express                               |
| `docs/`     | Installation, API reference, Android setup, deployment, troubleshooting    |

---

## Build status

The project is being built in phases. Each phase is complete and runnable before
the next begins.

- [x] **Phase 1 — Backend foundation:** config, logging, errors, middleware, health checks, Docker infra
- [x] **Phase 2 — Authentication:** users, JWT + rotating refresh tokens, API keys, RBAC, audit trail
- [x] **Phase 3 — Database:** MongoDB driver, document mapping, indexes at boot, repositories
- [x] **Phase 5 — WebSocket gateway:** device auth, registration, heartbeat, dispatch, delivery reports
- [x] **Phase 6 — React Native gateway app:** TurboModule over `SmsManager`, foreground service, release APK
- [x] **Multi-SIM:** dual-SIM phones expose both numbers; per-SIM daily cap; send-from routing
- [x] **Phase 7 — Admin panel:** served at `/admin` — monitor phones, message history, API keys, test-send
- [x] **Campaigns:** bulk / promotional send — upload an Excel/CSV list (or paste numbers), merge any number of
      columns into the message as `{variables}`, pick a SIM, drip one-by-one on a timer
- [ ] **Phase 4 — Queue:** BullMQ, retries, OTP helper
- [ ] **Phase 8 — Production deployment**

**Admin panel:** open `http://<server>:4000/admin` and sign in. Monitor every
gateway phone (live status, SIMs, daily usage vs cap), browse and search message
history, manage the API keys your apps use, fire test messages, and run
**campaigns**.

**Campaigns** are the bulk / promotional path. On the Campaigns tab you upload an
Excel/CSV list (or paste numbers, one per line — bare local numbers get your
chosen country code), pick which SIM sends, set the seconds between messages, and
press start. Every column of the uploaded sheet can be merged into the message:
mark which column holds the phone numbers, name the rest, and write "Hi {name},
your rent of {rent_amount} is due on {due_date}." — each person gets their own
values, with a live preview of a real row before anything sends. A
background runner then sends to each number one at a time, paced by that
interval, and you watch a live progress bar. Each recipient becomes a normal
message in the history. Two safety rails are deliberately not optional: the
per-SIM daily cap still applies, and the pace has a hard minimum — bulk texting
strangers from a personal SIM faster than that is what gets a number blacklisted.
See [`docs/CAMPAIGNS.md`](docs/CAMPAIGNS.md).

**Integrating into your own app:** see [`docs/INTEGRATION.md`](docs/INTEGRATION.md)
— the one endpoint, auth, error handling, and copy-paste examples in PHP, Node,
Python and curl.

Phases 5 and 6 landed before Phase 4 on purpose. The point was to get **one real
SMS out of a real SIM, end to end**, rather than build a queue for a delivery
mechanism that had never been proven to work. So the send path is deliberately
thin: `POST /api/sms/send` persists the message and hands it straight to a
connected phone. A message accepted while every phone is offline stays `QUEUED`,
and the next device to connect drains the backlog.

That is the entire queue today — no BullMQ, no retries, no daily quotas, no OTP.
Phase 4 is what makes it durable, and everything it needs is already in place.

---

## Quick start

**Prerequisites:** Node.js 22+, and either Docker Desktop or a MongoDB you can
already reach on `localhost:27017`.

```bash
# 1. Start MongoDB, Redis and mongo-express
docker compose -f docker/docker-compose.yml up -d

# 2. Configure the backend
cd backend
cp .env.example .env          # Windows: copy .env.example .env
npm install

# 3. Create the first admin (prints a generated password exactly once)
npm run db:seed

# 4. Run it
npm run dev
```

There are **no migrations to run.** Indexes are declared in `src/infra/mongo.ts`
and created at boot by `ensureIndexes()`, which is idempotent — so a fresh
database is correct the moment the server starts, and there is no "did anyone
remember to migrate?" step between deploying and serving traffic.

Verify:

```bash
curl http://localhost:4000/health          # {"success":true,"data":{"status":"ok",...}}
curl http://localhost:4000/health/ready    # readiness + per-dependency probes
curl http://localhost:4000/health/info     # version, uptime, memory
curl http://localhost:4000/api             # API index
```

Run the test suite:

```bash
npm test
```

The repository contract suite runs every assertion twice — once against the
in-memory store, once against a real MongoDB. It does **not** skip when you have
no database: if none is reachable it downloads and boots an ephemeral in-process
`mongod` instead. The store nobody runs locally is exactly the store that rots,
so it is never the one that goes unverified.

mongo-express (database browser) is at <http://localhost:8081>. The dev stack has
no authentication on either datastore — both are bound to localhost and hold
nothing. Production is a different story; see `docs/ENVIRONMENT.md`.

---

## Sending your first SMS

Once the backend is up, [`mobile/README.md`](mobile/README.md) has the full
runbook. The short version:

```bash
# 1. Mint a key for the phone. The gateway:connect scope is mandatory - without it
#    the WebSocket handshake is refused, so that a key given to a customer's server
#    can never impersonate a handset.
curl -X POST http://localhost:4000/api/auth/api-keys \
  -H "Authorization: Bearer <access token>" \
  -d '{"name":"My phone","scopes":["gateway:connect"]}'

# 2. Install mobile/android/app/build/outputs/apk/release/app-release.apk on an
#    Android phone with a SIM. Enter the server's LAN IP (NOT localhost - that is
#    the phone) and the key. Press Start.

# 3. Send.
curl -X POST http://localhost:4000/api/sms/send \
  -H "Authorization: Bearer <access token>" \
  -d '{"to":"+919876543210","body":"Hello from my own SIM"}'
```

The response is `202 Accepted`, not `201`: the message has been accepted for
delivery, but nothing has left the radio yet. `meta.dispatched` says whether a
phone was there to take it. Poll `GET /api/sms/:id` to watch it move
`QUEUED → SENDING → SENT → DELIVERED`.

`SENT` and `DELIVERED` are genuinely different: `SENT` means the SMS left the
handset, `DELIVERED` means the carrier confirmed it arrived. A delivery report is
network-dependent and often never comes at all, which is why they are separate
statuses rather than one boolean.

---

## Available scripts (`backend/`)

| Script              | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Hot-reloading dev server (tsx watch)          |
| `npm run build`     | Type-check and emit `dist/`                   |
| `npm start`         | Run the compiled build                        |
| `npm run typecheck` | Types only, no emit                           |
| `npm run lint`      | ESLint (type-aware rules)                     |
| `npm test`          | Vitest unit + integration tests               |
| `npm run test:coverage` | Tests with a V8 coverage report           |
| `npm run db:seed`   | Create the first admin + default settings (idempotent) |

---

## Licence

MIT
