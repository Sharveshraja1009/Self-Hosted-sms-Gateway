# SMS Gateway — Android app

The modem. This app holds a WebSocket open to the backend, receives messages, and
pushes them through the phone's own SIM with `SmsManager`.

## What React Native is doing here, and what it is not

React Native **cannot send an SMS from JavaScript.** There is no JS API for it and
there never will be — the SIM is driven by `android.telephony.SmsManager`, which is
Kotlin-only. (Expo's `expo-sms` only *opens the SMS composer* for a human to tap
Send. That is useless for a gateway.)

So the split is deliberate:

| Layer | Language | What lives there |
| --- | --- | --- |
| [`src/gateway.ts`](src/gateway.ts) | TypeScript | The WebSocket, the protocol, reconnect + backoff, heartbeat. **All the logic.** |
| [`App.tsx`](App.tsx) | TypeScript | Pairing, status, live activity log. |
| [`SmsSender.kt`](android/app/src/main/java/com/smsgateway/SmsSender.kt) | Kotlin | `SmsManager`, multipart splitting, sent/delivered receipts. |
| [`GatewayService.kt`](android/app/src/main/java/com/smsgateway/GatewayService.kt) | Kotlin | The foreground service that stops Android killing us. |
| [`SmsGatewayModule.kt`](android/app/src/main/java/com/smsgateway/SmsGatewayModule.kt) | Kotlin | The TurboModule bridging the two halves. |

The Kotlin is about 400 lines and it is boring on purpose. Everything you are
likely to want to change is TypeScript.

`specs/NativeSmsGateway.ts` is the contract between the two sides. Codegen turns it
into an abstract Kotlin class that `SmsGatewayModule` must implement — so if the
TypeScript and the Kotlin ever disagree about a signature, **the Android build
fails**, rather than the app throwing `undefined is not a function` on someone's
phone.

## Two things that will bite you

**Google Play restricts `SEND_SMS`.** An app requesting it must be the user's
default SMS handler or hold a granted exemption. This APK is sideloaded and never
listed, so it does not apply — but it is precisely why no "SMS gateway" app on the
Play Store actually works this way.

**Release builds block cleartext HTTP by default.** React Native sets
`usesCleartextTraffic=false` for release, which would leave the app unable to reach
`http://192.168.x.x:4000` and failing with an error that never mentions TLS.
[`network_security_config.xml`](android/app/src/main/res/xml/network_security_config.xml)
overrides that and explains the trade-off. Over the public internet, use an
`https://` URL — the app then negotiates `wss://` automatically.

## Building

Needs the Android SDK and a JDK 17 or 21. **Not JDK 23** — React Native's Gradle
plugin does not support it, and the failure is an opaque crash that never mentions
the JDK. Android Studio ships a suitable one:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
```

```bash
npm install

# Debug build, with Metro, on a connected device:
npm run android

# Release APK:
cd android && ./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

Release signing reads `android/keystore.properties`, which is **gitignored**. If it
is absent the build falls back to the debug key, so a fresh clone still builds and
runs — it just cannot produce a shippable update. Back that keystore up: lose it
and you can never publish an update to this app again, because Android identifies
an app by its signature, not its name.

## Pairing it with a server

1. On the backend, mint an API key carrying the **`gateway:connect`** scope. Without
   it the WebSocket handshake is refused with a 403 — deliberately, so that a key
   issued to a customer's server cannot impersonate a handset and start receiving
   that account's messages.

   ```bash
   curl -X POST http://localhost:4000/api/auth/api-keys \
     -H "Authorization: Bearer <access token>" \
     -H "Content-Type: application/json" \
     -d '{"name":"My phone","scopes":["gateway:connect"]}'
   ```

   The plaintext key is returned **once**. Copy it.

2. Install the APK, open the app, and enter:
   - **Server URL** — the backend's address *as the phone sees it*. Not
     `localhost`; that is the phone itself. Use the machine's LAN IP, e.g.
     `http://192.168.10.125:4000`. Phone and server must be on the same network.
   - **API key** — from step 1.

3. Save, then **Start gateway**, and grant SEND_SMS when asked.

4. The status turns **Online**, a permanent notification appears, and the phone
   shows up in `GET /api/gateways`.

## Sending

```bash
curl -X POST http://localhost:4000/api/sms/send \
  -H "Authorization: Bearer <access token>" \
  -H "Content-Type: application/json" \
  -d '{"to":"+919876543210","body":"Hello from my own SIM"}'
```

The response is **202 Accepted**, and `meta.dispatched` tells you whether a phone
was actually there to take it. Poll `GET /api/sms/:id` to watch the message move
`QUEUED → SENDING → SENT → DELIVERED`.

If no phone is connected the message stays `QUEUED`, and the next device to
register is handed the backlog. That is the entire queue for now — no BullMQ, no
retries, no quotas.

## When it does not work

The **Activity log on the app's main screen** is the first place to look. It exists
precisely so that you do not need a debugger in the field.

| Symptom | Cause |
| --- | --- |
| Stuck on "Reconnecting", code `1006` | Wrong URL or IP, phone on a different network, or the key lacks `gateway:connect`. The WebSocket API hides the HTTP status, so a *rejected handshake* and a *dead network* look identical from JavaScript. |
| "Cannot send: no SIM ready" | SEND_SMS was revoked, or no SIM is ready. The server marks the device DEGRADED and will not dispatch to it. |
| Connects, then dies after a few minutes | The foreground service was killed. Disable battery optimisation for the app. |
| Messages stuck in `SENDING` | The phone was handed the message but its report never came back. Check the activity log. |

Live native logs:

```bash
adb logcat -s SmsSender:V GatewayService:V ReactNativeJS:V
```
