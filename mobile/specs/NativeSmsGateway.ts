import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * The native boundary.
 *
 * Everything JavaScript cannot do on Android lives behind this interface, and
 * nothing else does. There are exactly two such things, and it is worth being
 * precise about why, because "just use a library" is the wrong instinct here:
 *
 *  1. **Sending an SMS.** There is no JS API for it and there never will be. The
 *     SIM is driven by `android.telephony.SmsManager`, which is Kotlin-only. Note
 *     what this is NOT: it is not opening the SMS composer for a human to tap
 *     Send (that is `expo-sms`, and it is useless for a gateway). This actually
 *     puts the message on the radio, unattended.
 *
 *  2. **Staying alive.** Android suspends a backgrounded app's JS within minutes,
 *     and a gateway that only works while you are looking at it is not a gateway.
 *     A foreground service - a persistent notification the OS respects - is the
 *     only sanctioned way to keep the process running, and it can only be started
 *     from native code.
 *
 * Everything else - the WebSocket, reconnection, the protocol, retries, the UI -
 * is deliberately in TypeScript, where it is far easier to reason about and
 * change. The Kotlin below is a thin, boring shell around two OS capabilities.
 *
 * Codegen turns this file into an abstract Kotlin class (`NativeSmsGatewaySpec`)
 * that SmsGatewayModule.kt must implement, so a mismatch between the two sides is
 * a compile error rather than an `undefined is not a function` on a user's phone.
 */
export interface Spec extends TurboModule {
  /**
   * Puts a message on the radio, from a specific SIM.
   *
   * Resolves as soon as Android has *accepted* the send - which is not the same
   * as the SMS having left the handset, and is very much not delivery. The real
   * outcome arrives later as a `sms.sent` / `sms.failed` / `sms.delivered` event,
   * because that is how the platform reports it: via PendingIntent broadcasts,
   * minutes later if the radio is busy.
   *
   * `messageId` is the server's id, threaded through so those async events can be
   * correlated back to the message that caused them.
   *
   * `subscriptionId` selects WHICH SIM sends it, and is what makes a dual-SIM
   * phone worth two numbers instead of one. Pass -1 to accept the phone's default
   * SMS SIM - which, on a handset holding two business numbers, is a coin toss.
   */
  sendSms(
    messageId: string,
    recipient: string,
    body: string,
    subscriptionId: number,
  ): Promise<void>;

  /**
   * Every SIM currently in this handset.
   *
   * Returns `{ sims: [{ subscriptionId, slot, carrier, number }] }`. `number` is
   * almost always null (carriers rarely write it to the SIM), so the operator
   * labels each slot by hand in the app. The label is bound to the SIM by
   * `subscriptionId`, never by the number - the id is the real identity, the
   * number is a human-typed string.
   */
  getSimCards(): Promise<Object>;

  /**
   * Battery, charging state, SIM operator, whether we can send at all.
   *
   * Returns an untyped object because codegen's struct support is more ceremony
   * than this earns; the shape is pinned on the TS side in native.ts.
   */
  getDeviceInfo(): Promise<Object>;

  /** True when SEND_SMS has been granted AND a SIM is actually present. */
  canSendSms(): Promise<boolean>;

  /**
   * This phone's recent call log, newest first. Returns
   * `{ granted, entries: [...] }`; `granted` is false when READ_CALL_LOG has not
   * been given (a state to show, not an error). Read on demand for the owner.
   */
  getCallLog(limit: number): Promise<Object>;

  /**
   * This phone's stored SMS (inbox + sent), newest first. Returns
   * `{ granted, messages: [...] }`; `granted` false = READ_SMS not given.
   */
  getDeviceSms(limit: number): Promise<Object>;

  /**
   * Starts the foreground service AND the native WebSocket connection to the
   * server. This is the modern entry point: the connection (register, heartbeat,
   * reconnect, and inbound `sms.send` handling) runs entirely in native code on
   * the service's own thread, so it survives the OS freezing the JavaScript
   * runtime in the background - the failure that made a JS-owned connection drop
   * offline the moment the screen turned off.
   *
   * `simLabels` is passed as a JSON string (`{"<subscriptionId>": "<+E164>"}`)
   * because codegen's map support is more ceremony than one field earns.
   * `heartbeatMs` is the app-level telemetry interval; the server overrides it on
   * registration. Progress is reported back via the `gateway.status`,
   * `gateway.log` and `gateway.sending` device events (see native.ts).
   */
  startGateway(
    serverUrl: string,
    apiKey: string,
    deviceId: string,
    deviceName: string,
    simLabelsJson: string,
    heartbeatMs: number,
  ): void;

  /**
   * Starts the foreground service only (legacy). Superseded by startGateway, which
   * also brings up the connection. Kept so older callers still resolve.
   */
  startGatewayService(statusText: string): void;

  /** Updates the persistent notification without restarting the service. */
  updateGatewayNotification(statusText: string): void;

  /** Stops the connection and the foreground service. */
  stopGatewayService(): void;

  /**
   * Is the app currently exempt from battery optimisation ("allowed to run in the
   * background")? When false, the OS is free to freeze or kill the process once the
   * screen is off, which is the usual reason a backgrounded gateway drops offline.
   */
  isIgnoringBatteryOptimizations(): Promise<boolean>;

  /**
   * Opens the system prompt that asks the user to exempt this app from battery
   * optimisation. A no-op if already exempt. This is the "allow background
   * activity" grant, requested the sanctioned way rather than silently.
   */
  requestDisableBatteryOptimization(): void;

  /**
   * Opens this app's system settings page. A universal fallback that exists on
   * every Android device.
   */
  openAppSettings(): void;

  /**
   * Opens the OEM "auto-start / protected apps" screen for whichever brand this is
   * - Xiaomi, Oppo, Vivo, Huawei, OnePlus each have their own - and falls back to
   * the app settings page on brands without one (Samsung, Pixel). This is the
   * cross-vendor "let me keep running" grant that battery optimisation alone does
   * not cover on some phones.
   */
  openAutoStartSettings(): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SmsGateway');
