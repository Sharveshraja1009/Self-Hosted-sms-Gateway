import { DeviceEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import type { EmitterSubscription } from 'react-native';

import NativeSmsGateway from '../specs/NativeSmsGateway';

/**
 * The typed face of the native module.
 *
 * `specs/NativeSmsGateway.ts` declares the raw boundary; this file is what the
 * rest of the app actually imports. It exists to put the two things codegen
 * cannot express behind a proper type:
 *
 *   - `getDeviceInfo()` returns `Object`, because codegen's struct support costs
 *     more ceremony than it earns here. The shape is pinned below instead.
 *   - The result events are emitted through RCTDeviceEventEmitter, which is
 *     stringly-typed on both sides. The subscribe helpers below are the one place
 *     those strings appear.
 */

export interface DeviceInfo {
  deviceName: string;
  androidVersion: string;
  /** -1 when the battery could not be read. Never invent a percentage. */
  batteryLevel: number;
  isCharging: boolean;
  /** SEND_SMS granted AND a SIM is ready. False means this handset cannot send. */
  canSendSms: boolean;
  simOperator: string | null;
  phoneNumber: string | null;
}

export interface SmsSentEvent {
  messageId: string;
}

export interface SmsFailedEvent {
  messageId: string;
  errorCode: string;
  errorMessage: string;
}

/** One entry in the phone's call log. `timestamp` is epoch ms. */
export interface CallLogEntry {
  number: string | null;
  name: string | null;
  direction: 'incoming' | 'outgoing' | 'missed' | 'rejected' | 'blocked' | 'voicemail' | 'unknown';
  timestamp: number;
  durationSec: number;
}

/** One stored SMS on the phone. */
export interface DeviceSmsEntry {
  address: string | null;
  body: string;
  box: 'inbox' | 'sent' | 'draft' | 'outbox' | 'failed' | 'queued' | 'unknown';
  timestamp: number;
}

/** One SIM in the handset. */
export interface SimCard {
  /** Android's handle for this SIM. The ONLY reliable identity - not the number. */
  subscriptionId: number;
  /** 1 or 2, matching what the phone's own Settings screen calls them. */
  slot: number;
  carrier: string;
  /** Almost always null. Carriers rarely write the number to the SIM. */
  number: string | null;
}

/** Everything the native connection needs to reach the server. */
export interface StartGatewayConfig {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  deviceName: string;
  simLabels: Record<string, string>;
  /** App-level telemetry heartbeat; the server overrides it on registration. */
  heartbeatMs?: number;
}

/** Connection-state pushed from the native connection (mirrors gateway.ts ConnectionState). */
export interface GatewayStatusEvent {
  state: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error';
  detail: string | null;
  gatewayId: string | null;
}

/** A human-readable line from the native connection, for the activity log. */
export interface GatewayLogEvent {
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Fired the instant the native side is handed a message to send, so the UI can record it. */
export interface GatewaySendingEvent {
  messageId: string;
  to: string;
  body: string;
  from: string | null;
}

export const native = {
  /**
   * Puts a message on the radio, from a specific SIM.
   *
   * Resolving means only that Android accepted it. The real outcome lands later
   * on `onSmsSent` / `onSmsFailed`, because that is genuinely how the platform
   * reports it - see the long note in SmsSender.kt.
   *
   * `subscriptionId` of -1 means "the phone's default SMS SIM", which on a
   * dual-SIM handset is whichever one the user picked in Settings - i.e. not
   * something a gateway should ever rely on.
   */
  sendSms(messageId: string, recipient: string, body: string, subscriptionId = -1): Promise<void> {
    return NativeSmsGateway.sendSms(messageId, recipient, body, subscriptionId);
  },

  async getSimCards(): Promise<SimCard[]> {
    const result = (await NativeSmsGateway.getSimCards()) as { sims?: SimCard[] };
    return result.sims ?? [];
  },

  async getDeviceInfo(): Promise<DeviceInfo> {
    return (await NativeSmsGateway.getDeviceInfo()) as DeviceInfo;
  },

  canSendSms(): Promise<boolean> {
    return NativeSmsGateway.canSendSms();
  },

  async getCallLog(limit = 100): Promise<{ granted: boolean; entries: CallLogEntry[] }> {
    const result = (await NativeSmsGateway.getCallLog(limit)) as {
      granted?: boolean;
      entries?: CallLogEntry[];
    };
    return { granted: result.granted ?? false, entries: result.entries ?? [] };
  },

  async getDeviceSms(limit = 100): Promise<{ granted: boolean; messages: DeviceSmsEntry[] }> {
    const result = (await NativeSmsGateway.getDeviceSms(limit)) as {
      granted?: boolean;
      messages?: DeviceSmsEntry[];
    };
    return { granted: result.granted ?? false, messages: result.messages ?? [] };
  },

  /**
   * Start the foreground service AND the native WebSocket connection. Everything
   * after this - register, heartbeat, reconnect, sending - runs in native code, so
   * it survives the OS freezing this JS runtime in the background.
   */
  startGateway(config: StartGatewayConfig): void {
    NativeSmsGateway.startGateway(
      config.serverUrl,
      config.apiKey,
      config.deviceId,
      config.deviceName,
      JSON.stringify(config.simLabels ?? {}),
      config.heartbeatMs ?? 30_000,
    );
  },

  startService(statusText: string): void {
    NativeSmsGateway.startGatewayService(statusText);
  },

  updateNotification(statusText: string): void {
    NativeSmsGateway.updateGatewayNotification(statusText);
  },

  stopService(): void {
    NativeSmsGateway.stopGatewayService();
  },

  /** Connection-state changes from the native connection. */
  onGatewayStatus(handler: (event: GatewayStatusEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener('gateway.status', handler);
  },

  /** Activity-log lines from the native connection. */
  onGatewayLog(handler: (event: GatewayLogEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener('gateway.log', handler);
  },

  /** Fired when the native side starts sending a message, so the UI can record it. */
  onGatewaySending(handler: (event: GatewaySendingEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener('gateway.sending', handler);
  },

  /** Is the app exempt from battery optimisation (allowed to run in the background)? */
  isIgnoringBatteryOptimizations(): Promise<boolean> {
    return NativeSmsGateway.isIgnoringBatteryOptimizations();
  },

  /** Show the system "allow background activity" prompt. */
  requestDisableBatteryOptimization(): void {
    NativeSmsGateway.requestDisableBatteryOptimization();
  },

  /** Open this app's settings page (universal fallback). */
  openAppSettings(): void {
    NativeSmsGateway.openAppSettings();
  },

  /** Open the OEM auto-start / protected-apps screen (Xiaomi/Oppo/Vivo/Huawei/OnePlus), else app settings. */
  openAutoStartSettings(): void {
    NativeSmsGateway.openAutoStartSettings();
  },

  onSmsSent(handler: (event: SmsSentEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener('sms.sent', handler);
  },

  onSmsFailed(handler: (event: SmsFailedEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener('sms.failed', handler);
  },

  onSmsDelivered(handler: (event: SmsSentEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener('sms.delivered', handler);
  },
};

/**
 * Asks for everything the gateway needs, in one prompt.
 *
 * SEND_SMS is the only one that is fatal to refuse - without it the app cannot do
 * its job at all. The other two degrade rather than break: no POST_NOTIFICATIONS
 * means the foreground service has no visible notification (and Android will
 * eventually kill it), and no READ_PHONE_STATE means we cannot tell "no SIM"
 * apart from "SIM fine", so we lose a diagnostic but keep the capability.
 *
 * Returns whether the app can actually function, not whether every box was ticked.
 */
export async function requestPermissions(): Promise<{ granted: boolean; missing: string[] }> {
  if (Platform.OS !== 'android') {
    return { granted: false, missing: ['This app only works on Android'] };
  }

  const wanted: string[] = [
    PermissionsAndroid.PERMISSIONS.SEND_SMS,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    // For the owner's call-log / SMS viewer in the admin panel. Optional: denying
    // them does not stop the gateway (see the `granted` flag), it only makes those
    // two panels say "not granted on the phone".
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    PermissionsAndroid.PERMISSIONS.READ_SMS,
  ];

  // Both of these only exist from Android 13 (API 33). Requesting an unknown
  // permission on an older device returns 'never_ask_again', which would make us
  // report a permanent failure for something that was never required.
  if (Number(Platform.Version) >= 33) {
    wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    // Lets us *try* to read the SIM's own number. It usually still fails - the
    // carrier simply never wrote it - which is why the app has a manual field.
    wanted.push(PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS);
  }

  const results = await PermissionsAndroid.requestMultiple(
    wanted as Parameters<typeof PermissionsAndroid.requestMultiple>[0],
  );

  const missing = wanted.filter(
    (permission) => results[permission as keyof typeof results] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  const smsGranted =
    results[PermissionsAndroid.PERMISSIONS.SEND_SMS as keyof typeof results] ===
    PermissionsAndroid.RESULTS.GRANTED;

  return { granted: smsGranted, missing };
}
