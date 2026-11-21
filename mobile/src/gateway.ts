import type { EmitterSubscription } from 'react-native';

import { type GatewayConfig, websocketUrl } from './config';
import { type HistoryEntry, recordSend, updateStatus } from './history';
import { native, type SimCard } from './native';

/**
 * The SIM list the server needs, built from what the phone actually has plus the
 * operator's typed labels.
 *
 * The label (config.simLabels) wins over anything Android reports, because
 * Android's `SubscriptionInfo.number` is empty far more often than it is right.
 * Keyed by subscriptionId - the SIM's stable identity - so a relabel or a slot
 * swap re-associates correctly.
 */
interface ReportedSim {
  subscriptionId: number;
  slot: number;
  carrier: string | null;
  phoneNumber: string | null;
}

function buildSimReport(cards: SimCard[], labels: Record<string, string>): ReportedSim[] {
  return cards.map((card) => ({
    subscriptionId: card.subscriptionId,
    slot: card.slot,
    carrier: card.carrier,
    phoneNumber: labels[String(card.subscriptionId)] ?? card.number ?? null,
  }));
}

/**
 * The gateway client - the mirror image of backend/src/modules/gateway/.
 *
 * This is where all the actual logic of the app lives, and it is in TypeScript on
 * purpose: reconnection, backoff, heartbeat and protocol handling are exactly the
 * things you want to be able to read and change quickly. The Kotlin underneath is
 * two OS calls and a notification.
 *
 * The connection is a state machine with one rule that matters: **it never gives
 * up.** A phone acting as a modem will lose its network - lifts, tunnels, dead
 * spots, carrier hiccups - and an app that stops retrying after N attempts is an
 * app that is silently dead by Tuesday. So the backoff grows and then plateaus;
 * it never terminates.
 */

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error';

export interface LogEntry {
  id: number;
  at: Date;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface GatewayStatus {
  state: ConnectionState;
  /** Set when state is 'error' - the reason, in words a human can act on. */
  detail: string | null;
  gatewayId: string | null;
  sentCount: number;
  failedCount: number;
}

export interface GatewayCallbacks {
  onStatus: (status: GatewayStatus) => void;
  onLog: (entry: LogEntry) => void;
  /** Fires with the WHOLE history after every change, so the UI can just render it. */
  onHistory: (entries: HistoryEntry[]) => void;
}

/** Backoff: 1s, 2s, 4s, 8s, 16s, then every 30s forever. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_BACKOFF_MS = 30_000;

const DEFAULT_HEARTBEAT_MS = 30_000;

let logCounter = 0;

export class GatewayClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: EmitterSubscription[] = [];

  private attempt = 0;
  /** Set when the user asks to stop. Distinguishes "we hung up" from "it dropped". */
  private stopped = false;

  private status: GatewayStatus = {
    state: 'idle',
    detail: null,
    gatewayId: null,
    sentCount: 0,
    failedCount: 0,
  };

  constructor(
    private readonly config: GatewayConfig,
    private readonly callbacks: GatewayCallbacks,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    this.attempt = 0;

    // Subscribe to the native SMS result events ONCE, for the life of the client,
    // not per-connection. A send can complete after the socket has dropped - the
    // radio does not care about our WebSocket - and the report must still be
    // delivered when we reconnect rather than falling on the floor.
    this.subscriptions = [
      native.onSmsSent(({ messageId }) => {
        this.status.sentCount += 1;
        this.log('info', `SMS sent (${messageId.slice(0, 8)})`);
        this.emit({ type: 'sms.result', messageId, status: 'SENT' });
        this.pushStatus();
        void this.history(messageId, { status: 'SENT' });
      }),

      native.onSmsFailed(({ messageId, errorCode, errorMessage }) => {
        this.status.failedCount += 1;
        this.log('error', `SMS failed (${messageId.slice(0, 8)}): ${errorCode}`);
        this.emit({ type: 'sms.result', messageId, status: 'FAILED', errorCode, errorMessage });
        this.pushStatus();
        void this.history(messageId, { status: 'FAILED', errorCode, errorMessage });
      }),

      native.onSmsDelivered(({ messageId }) => {
        this.log('info', `Delivered (${messageId.slice(0, 8)})`);
        this.emit({ type: 'sms.delivered', messageId });
        void this.history(messageId, { status: 'DELIVERED' });
      }),
    ];

    native.startService('Connecting…');
    this.connect();
  }

  stop(): void {
    this.stopped = true;

    this.clearTimers();

    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions = [];

    // 1000 = normal closure. The server reads this as a deliberate hang-up rather
    // than a device that fell off the network, and does not log it as an anomaly.
    this.socket?.close(1000, 'Stopped by the user');
    this.socket = null;

    native.stopService();

    this.setStatus({ state: 'idle', detail: null, gatewayId: null });
    this.log('info', 'Gateway stopped');
  }

  getStatus(): GatewayStatus {
    return { ...this.status };
  }

  // -------------------------------------------------------------------------
  // The socket
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;

    const url = websocketUrl(this.config);
    this.setStatus({ state: this.attempt === 0 ? 'connecting' : 'reconnecting' });
    this.log('info', `Connecting to ${url}`);

    // React Native's WebSocket accepts headers as the third argument on Android.
    // The server also accepts ?apiKey= for clients that cannot set headers, but a
    // header keeps the key out of the URL - and therefore out of every proxy log
    // between here and the server.
    const socket = new WebSocket(url, undefined, {
      headers: { 'x-api-key': this.config.apiKey },
    });

    this.socket = socket;

    socket.onopen = () => {
      void this.onOpen();
    };

    socket.onmessage = (event: WebSocketMessageEvent) => {
      void this.onMessage(String(event.data));
    };

    socket.onerror = () => {
      // RN's WebSocket error event carries almost nothing useful - no status code,
      // no reason. The genuinely diagnostic information arrives in onclose, so we
      // do not try to invent a message here.
      this.log('warn', 'Socket error');
    };

    socket.onclose = (event: WebSocketCloseEvent) => {
      this.onClose(event.code ?? 0, event.reason ?? '');
    };
  }

  private async onOpen(): Promise<void> {
    this.log('info', 'Connected - registering');

    const info = await native.getDeviceInfo();
    const sims = buildSimReport(await native.getSimCards(), this.config.simLabels);

    // The first SIM's number doubles as the legacy single `phoneNumber` field, so
    // an older server that does not understand `sims` still gets a sensible "from".
    const primary = sims[0]?.phoneNumber ?? info.phoneNumber;

    this.send({
      type: 'register',
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName || info.deviceName,
      batteryLevel: info.batteryLevel >= 0 ? info.batteryLevel : null,
      isCharging: info.isCharging,
      canSendSms: info.canSendSms,
      simOperator: info.simOperator,
      phoneNumber: primary,
      androidVersion: info.androidVersion,
      appVersion: '1.0.0',
      sims,
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let frame: Record<string, unknown>;

    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log('warn', 'Ignored a malformed frame from the server');
      return;
    }

    switch (frame.type) {
      case 'registered': {
        // The connection is only *usable* now, not at onopen: before the server
        // acknowledges the registration it has no Gateway record to dispatch to.
        this.attempt = 0;
        const gatewayId = String(frame.gatewayId);

        this.setStatus({ state: 'online', detail: null, gatewayId });
        this.log('info', 'Registered with the server');
        native.updateNotification('Connected - ready to send');

        this.startHeartbeat(Number(frame.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_MS);
        break;
      }

      case 'sms.send':
        await this.handleSendRequest(frame);
        break;

      case 'calllog.request':
        await this.handleCallLogRequest(frame);
        break;

      case 'deviceSms.request':
        await this.handleDeviceSmsRequest(frame);
        break;

      case 'heartbeat.ack':
        // Nothing to do. The value is in the server having heard from us, not in
        // anything it says back.
        break;

      case 'error':
        this.log('error', `Server: ${String(frame.message)}`);
        break;

      default:
        this.log('warn', `Unknown frame type: ${String(frame.type)}`);
    }
  }

  /**
   * The server wants an SMS sent.
   *
   * Note what this does NOT do: report success. `native.sendSms()` resolving means
   * only that Android took the message. The SENT/FAILED report comes back later,
   * through the event subscriptions set up in start(), because that is when the
   * radio actually knows. Reporting here would mark every message SENT the instant
   * it was queued, including the ones about to fail with NO_SERVICE.
   */
  private async handleSendRequest(frame: Record<string, unknown>): Promise<void> {
    const messageId = String(frame.messageId);
    const recipient = String(frame.recipient);
    const body = String(frame.body);

    // WHICH SIM the server chose. The phone obeys - it does not fall back to its
    // own default, because on a dual-SIM handset that would send from the wrong
    // number and contradict the "from" the server just recorded. -1 (single-SIM
    // fallback) means "use the default", which is only ever correct when there is
    // exactly one SIM.
    const subscriptionId = typeof frame.subscriptionId === 'number' ? frame.subscriptionId : -1;

    // The server tells us which number it believes that SIM sends from, so the
    // phone's history and the server's records cannot disagree about "from".
    const senderNumber =
      typeof frame.senderNumber === 'string' && frame.senderNumber.length > 0
        ? frame.senderNumber
        : this.config.simLabels[String(subscriptionId)] ?? null;

    this.log('info', `Sending to ${recipient}`);

    // Recorded BEFORE the radio is touched. If the process dies mid-send, an entry
    // stuck at SENDING is a visible fact someone can investigate; a message that
    // went out leaving no trace at all is not.
    this.callbacks.onHistory(
      await recordSend({ id: messageId, from: senderNumber, to: recipient, body }),
    );

    try {
      await native.sendSms(messageId, recipient, body, subscriptionId);
    } catch (error) {
      // A synchronous refusal: permission revoked, no SIM. There will be no
      // asynchronous event for this one, so it must be reported from here or the
      // message would sit in SENDING forever.
      const message = error instanceof Error ? error.message : String(error);

      this.status.failedCount += 1;
      this.log('error', `Could not send: ${message}`);

      this.emit({
        type: 'sms.result',
        messageId,
        status: 'FAILED',
        errorCode: 'DEVICE_REFUSED',
        errorMessage: message,
      });

      this.pushStatus();
      void this.history(messageId, {
        status: 'FAILED',
        errorCode: 'DEVICE_REFUSED',
        errorMessage: message,
      });
    }
  }

  /**
   * The server (on behalf of the panel) asked for this phone's call log. Read it
   * and reply, echoing the requestId so the server can match the waiting request.
   * `granted:false` (READ_CALL_LOG not given) is a normal reply, not a failure.
   */
  private async handleCallLogRequest(frame: Record<string, unknown>): Promise<void> {
    const requestId = String(frame.requestId);
    const limit = typeof frame.limit === 'number' ? frame.limit : 100;

    const { granted, entries } = await native.getCallLog(limit);
    this.log('info', `Sent call log (${entries.length})`);
    this.send({ type: 'calllog.response', requestId, granted, entries });
  }

  /** As above, for the phone's stored SMS. */
  private async handleDeviceSmsRequest(frame: Record<string, unknown>): Promise<void> {
    const requestId = String(frame.requestId);
    const limit = typeof frame.limit === 'number' ? frame.limit : 100;

    const { granted, messages } = await native.getDeviceSms(limit);
    this.log('info', `Sent messages (${messages.length})`);
    this.send({ type: 'deviceSms.response', requestId, granted, messages });
  }

  /** Applies an outcome to the stored history and pushes the whole list to the UI. */
  private async history(
    messageId: string,
    patch: Parameters<typeof updateStatus>[1],
  ): Promise<void> {
    this.callbacks.onHistory(await updateStatus(messageId, patch));
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers();
    this.socket = null;

    if (this.stopped) return;

    // 4001 is our own "you never registered"; 4000 is "replaced by a newer
    // connection". Neither is worth retrying instantly.
    const detail = describeClose(code, reason);

    this.log('warn', `Disconnected: ${detail}`);
    this.setStatus({ state: 'reconnecting', detail });

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_MS[this.attempt] ?? MAX_BACKOFF_MS;
    this.attempt += 1;

    native.updateNotification(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    this.log('info', `Reconnecting in ${Math.round(delay / 1000)}s`);

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();

    const beat = async (): Promise<void> => {
      const info = await native.getDeviceInfo();
      const sims = buildSimReport(await native.getSimCards(), this.config.simLabels);

      this.send({
        type: 'heartbeat',
        batteryLevel: info.batteryLevel >= 0 ? info.batteryLevel : null,
        isCharging: info.isCharging,
        canSendSms: info.canSendSms,
        simOperator: info.simOperator,
        phoneNumber: sims[0]?.phoneNumber ?? info.phoneNumber,
        // Re-sent every heartbeat so relabelling a SIM in the app takes effect
        // without a reconnect.
        sims,
      });

      // Refresh the notification so the user can see the gateway is alive without
      // opening the app - which is the only signal they will ever routinely see.
      const suffix = info.canSendSms ? '' : ' - CANNOT SEND (check SIM/permission)';
      native.updateNotification(`Connected${suffix} · ${info.batteryLevel}%`);
    };

    void beat();
    this.heartbeatTimer = setInterval(() => void beat(), intervalMs);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** Sends a frame. Silently drops it if the socket is not open. */
  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState !== 1 /* OPEN */) return;
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * Sends a frame that MUST NOT be lost if the socket happens to be down.
   *
   * ...except that, honestly, it can be. A delivery report that never reaches the
   * server leaves the message stuck in SENDING, which is visible and diagnosable.
   * The alternative - a durable on-device outbox - is real work, and it belongs in
   * the phase that also brings retries. Flagged here rather than silently pretended
   * away.
   */
  private emit(frame: Record<string, unknown>): void {
    if (this.socket?.readyState !== 1) {
      this.log('warn', 'Socket down - a delivery report was dropped');
      return;
    }

    this.send(frame);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(patch: Partial<GatewayStatus>): void {
    this.status = { ...this.status, ...patch };
    this.pushStatus();
  }

  private pushStatus(): void {
    this.callbacks.onStatus({ ...this.status });
  }

  private log(level: LogEntry['level'], text: string): void {
    logCounter += 1;
    this.callbacks.onLog({ id: logCounter, at: new Date(), level, text });
  }
}

/**
 * Turns a close code into something a user can act on.
 *
 * A raw "1006" tells them nothing. "Rejected - check the API key" tells them
 * exactly which field to go and fix, which is the difference between an app that
 * is debuggable in the field and one that is not.
 */
function describeClose(code: number, reason: string): string {
  if (reason) return `${reason} (${code})`;

  switch (code) {
    case 1000:
      return 'Closed normally';
    case 1001:
      return 'The server is restarting';
    case 1006:
      // The one you will actually see. 1006 is "abnormal closure, no close frame"
      // - which is what both a rejected handshake (401/403) and a dead network
      // look like from JavaScript, because the browser API hides the HTTP status.
      return 'Connection lost - check the server URL, the API key, and its gateway:connect scope';
    case 4000:
      return 'Replaced by a newer connection from this device';
    case 4001:
      return 'The server timed out waiting for registration';
    default:
      return `Closed with code ${code}`;
  }
}
