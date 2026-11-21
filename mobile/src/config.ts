import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persisted pairing configuration.
 *
 * The deviceId is the interesting one. It is generated ONCE, on first launch, and
 * then never changes for the life of the install - because the server upserts its
 * `Gateway` record on it. If it were regenerated on every start, every restart of
 * the app would mint a brand-new device row, and a user with one phone would
 * watch their device list fill up with ghosts.
 *
 * It deliberately does not use anything hardware-derived (ANDROID_ID, IMEI). Those
 * are either privileged, or unstable across OS versions, or both - and we do not
 * need to identify the *handset*, only this installation of this app.
 */

const KEYS = {
  serverUrl: 'gateway.serverUrl',
  apiKey: 'gateway.apiKey',
  deviceId: 'gateway.deviceId',
  deviceName: 'gateway.deviceName',
  simLabels: 'gateway.simLabels',
  autoStart: 'gateway.autoStart',
} as const;

const E164 = /^\+[1-9]\d{7,14}$/;

export interface GatewayConfig {
  /** e.g. http://192.168.1.5:4000 - the backend's base URL, no trailing slash. */
  serverUrl: string;
  /** An API key carrying the `gateway:connect` scope. */
  apiKey: string;
  deviceId: string;
  deviceName: string;
  /**
   * The number an operator typed in for each SIM, keyed by Android's
   * `subscriptionId` (as a string, because JSON object keys are strings).
   *
   * This exists because Android almost never tells us a SIM's own number - it
   * lives in the carrier's records, not on the handset. So the app tries to read
   * it, and when that fails, a human labels each slot. Keyed by subscriptionId,
   * NOT by number, because the id is the stable identity of the SIM and the
   * number is the human-supplied label bound to it. Nothing authenticates the
   * number; it is what "from" shows.
   */
  simLabels: Record<string, string>;
  autoStart: boolean;
}

/** Parses the stored JSON, keeping only entries that are valid E.164. Never throws. */
function parseSimLabels(raw: string | null): Record<string, string> {
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};

    const out: Record<string, string> = {};
    for (const [subId, number] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof number === 'string' && E164.test(number)) out[subId] = number;
    }
    return out;
  } catch {
    return {};
  }
}

function randomDeviceId(): string {
  // Not crypto - this is an identifier, not a secret. The API key is what
  // authenticates; the deviceId only says "which phone".
  const random = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `android-${random}`.slice(0, 32).padEnd(24, '0');
}

export async function loadConfig(): Promise<GatewayConfig> {
  const stored = await AsyncStorage.getMany([
    KEYS.serverUrl,
    KEYS.apiKey,
    KEYS.deviceId,
    KEYS.deviceName,
    KEYS.simLabels,
    KEYS.autoStart,
  ]);

  let deviceId = stored[KEYS.deviceId];

  // First launch. Mint an id and persist it before anything can read it.
  if (!deviceId) {
    deviceId = randomDeviceId();
    await AsyncStorage.setItem(KEYS.deviceId, deviceId);
  }

  return {
    serverUrl: stored[KEYS.serverUrl] ?? '',
    apiKey: stored[KEYS.apiKey] ?? '',
    deviceId,
    deviceName: stored[KEYS.deviceName] ?? '',
    simLabels: parseSimLabels(stored[KEYS.simLabels]),
    autoStart: stored[KEYS.autoStart] === 'true',
  };
}

export async function saveConfig(config: Partial<Omit<GatewayConfig, 'deviceId'>>): Promise<void> {
  const entries: Record<string, string> = {};

  if (config.serverUrl !== undefined) {
    // A trailing slash silently produces "http://host:4000//api/..." which some
    // proxies answer with a 404. Normalise once, here, not at every call site.
    entries[KEYS.serverUrl] = config.serverUrl.trim().replace(/\/+$/, '');
  }
  if (config.apiKey !== undefined) entries[KEYS.apiKey] = config.apiKey.trim();
  if (config.deviceName !== undefined) entries[KEYS.deviceName] = config.deviceName.trim();
  if (config.autoStart !== undefined) entries[KEYS.autoStart] = String(config.autoStart);

  if (config.simLabels !== undefined) {
    // Clean and validate each number. A blank entry (the operator cleared the
    // field) is dropped rather than stored, so an empty label never masquerades
    // as a real "from". Only E.164 survives; a half-typed number is discarded,
    // and the caller can compare what it sent to what came back to detect that.
    const cleaned: Record<string, string> = {};
    for (const [subId, number] of Object.entries(config.simLabels)) {
      const normalised = number.replace(/[\s()-]/g, '');
      if (E164.test(normalised)) cleaned[subId] = normalised;
    }
    entries[KEYS.simLabels] = JSON.stringify(cleaned);
  }

  if (Object.keys(entries).length > 0) {
    await AsyncStorage.setMany(entries);
  }
}

export function isConfigured(config: GatewayConfig): boolean {
  return config.serverUrl.length > 0 && config.apiKey.length > 0;
}

/**
 * The scheme + host (+ port) of the configured server, with any path, query or
 * trailing slash stripped off.
 *
 * This exists because the single most common pairing mistake is pasting the
 * *admin panel* URL - `https://host/admin/` - into the Server URL field. The API
 * and the WebSocket both live at the ROOT, so a naive concatenation would build
 * `https://host/admin/api/...` and `wss://host/admin/ws/gateway`, both of which
 * 404. We take only the origin and ignore whatever path was pasted, so the admin
 * URL and the base URL behave identically. Missing scheme defaults to http (a
 * self-hosted LAN box usually has no TLS).
 */
export function serverOrigin(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  const isHttps = /^https:\/\//i.test(trimmed);
  const host = trimmed
    .replace(/^https?:\/\//i, '') // drop the scheme
    .replace(/[/?#].*$/, ''); // drop the path / query / fragment

  return (isHttps ? 'https://' : 'http://') + host;
}

/**
 * Turns the configured server URL into the gateway's WebSocket URL.
 *
 * https -> wss, everything else -> ws. Getting this wrong is the most common way
 * to lose an hour to a connection that was never going to work: an `https` server
 * will refuse a plain `ws` upgrade, and the error surfaces as a bare "connection
 * failed" with no hint as to why. Built from the origin, so a pasted `/admin`
 * path cannot corrupt it.
 */
export function websocketUrl(config: GatewayConfig): string {
  return serverOrigin(config.serverUrl).replace(/^http/i, 'ws') + '/ws/gateway';
}
