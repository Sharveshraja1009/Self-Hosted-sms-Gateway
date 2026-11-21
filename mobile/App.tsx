import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ApiError, normaliseNumber, sendTestSms } from './src/api';
import { type GatewayConfig, isConfigured, loadConfig, saveConfig } from './src/config';
import { type GatewayStatus, type LogEntry } from './src/gateway';
import { clearHistory, type HistoryEntry, loadHistory, recordSend, updateStatus } from './src/history';
import {
  type DeviceInfo,
  type GatewayLogEvent,
  type GatewaySendingEvent,
  type GatewayStatusEvent,
  native,
  requestPermissions,
  type SimCard,
} from './src/native';

/**
 * The whole UI - one screen, deliberately.
 *
 * This app has exactly one job, and its user opens it roughly twice: once to pair
 * it with a server, and once more when something has gone wrong. So the design
 * goal for the second visit is that it answers "why is it not working?" without
 * anyone needing to attach a debugger. That is what the live activity log is for,
 * and it is the most useful thing on the screen.
 */

const IDLE_STATUS: GatewayStatus = {
  state: 'idle',
  detail: null,
  gatewayId: null,
  sentCount: 0,
  failedCount: 0,
};

export default function App(): React.JSX.Element {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [status, setStatus] = useState<GatewayStatus>(IDLE_STATUS);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [serverUrl, setServerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [deviceName, setDeviceName] = useState('');

  // The SIMs Android reports, and the operator's typed number for each (keyed by
  // subscriptionId). Two pieces of state because one is discovered and the other
  // is entered - a dual-SIM phone shows two rows here.
  const [sims, setSims] = useState<SimCard[]>([]);
  const [simLabels, setSimLabels] = useState<Record<string, string>>({});

  // The built-in test panel.
  const [testTo, setTestTo] = useState('');
  const [testBody, setTestBody] = useState('Test from the SMS gateway.');
  const [sending, setSending] = useState(false);

  // Whether the app is exempt from battery optimisation ("allowed to run in the
  // background"). null = not checked yet. This is the single biggest factor in
  // whether the gateway survives with the screen off.
  const [batteryOk, setBatteryOk] = useState<boolean | null>(null);
  // Guards the one-time auto-start when the app relaunches already configured.
  const autoStarted = useRef(false);

  // The socket now lives in native code (so it survives the screen being off), so
  // there is no client object to hold here. The UI only tallies the result events
  // the native side emits; the tallies live in a ref and are mirrored into `status`.
  const counts = useRef({ sent: 0, failed: 0 });
  const logSeq = useRef(0);

  const appendLog = useCallback((entry: LogEntry) => {
    // Newest first, and capped. An unbounded log on a device that runs for weeks
    // is a memory leak with a user interface.
    setLogs((current) => [entry, ...current].slice(0, 200));
  }, []);

  useEffect(() => {
    void (async () => {
      const loaded = await loadConfig();
      setConfig(loaded);
      setServerUrl(loaded.serverUrl);
      setApiKey(loaded.apiKey);

      // History is persisted, so it must be there on a cold start - "did that OTP
      // go out this morning?" is asked hours later, long after the log has died.
      setHistory(await loadHistory());

      const info = await native.getDeviceInfo();
      setDevice(info);
      setDeviceName(loaded.deviceName || info.deviceName);

      // Enumerate the SIMs so each can be labelled. A dual-SIM phone returns two;
      // a phone that denies the permission returns none, and the UI says so.
      setSimLabels(loaded.simLabels);
      setSims(await native.getSimCards());

      // Is the app allowed to run in the background? Drives the warning card.
      native.isIgnoringBatteryOptimizations().then(setBatteryOk).catch(() => setBatteryOk(null));
    })();

    // No cleanup that stops the client, on purpose. The foreground service is
    // meant to OUTLIVE this component - that is the entire point of it - so
    // teardown only ever happens explicitly, via the Stop button.
  }, []);

  // Bridge the NATIVE connection's events to the UI. The connection itself lives in
  // Kotlin now (so it keeps running with the screen off); these listeners are only
  // how its progress reaches the screen while the app is in the foreground. When the
  // app is backgrounded and the JS is frozen, the events are simply dropped and the
  // UI catches up on the next foreground - the connection never stops.
  useEffect(() => {
    const subs = [
      native.onGatewayStatus((e: GatewayStatusEvent) => {
        setStatus((prev) => ({ ...prev, state: e.state, detail: e.detail, gatewayId: e.gatewayId }));
      }),
      native.onGatewayLog((e: GatewayLogEvent) => {
        setLogs((current) =>
          [{ id: (logSeq.current += 1), at: new Date(), level: e.level, text: e.text }, ...current].slice(0, 200),
        );
      }),
      native.onGatewaySending((e: GatewaySendingEvent) => {
        void recordSend({ id: e.messageId, from: e.from, to: e.to, body: e.body }).then(setHistory);
      }),
      native.onSmsSent(({ messageId }) => {
        counts.current.sent += 1;
        setStatus((prev) => ({ ...prev, sentCount: counts.current.sent }));
        void updateStatus(messageId, { status: 'SENT' }).then(setHistory);
      }),
      native.onSmsFailed(({ messageId, errorCode, errorMessage }) => {
        counts.current.failed += 1;
        setStatus((prev) => ({ ...prev, failedCount: counts.current.failed }));
        void updateStatus(messageId, { status: 'FAILED', errorCode, errorMessage }).then(setHistory);
      }),
      native.onSmsDelivered(({ messageId }) => {
        void updateStatus(messageId, { status: 'DELIVERED' }).then(setHistory);
      }),
    ];

    return () => subs.forEach((sub) => sub.remove());
  }, []);

  const start = useCallback(async () => {
    if (!config) return;

    const permission = await requestPermissions();

    if (!permission.granted) {
      Alert.alert(
        'SMS permission required',
        'This app cannot send anything without SEND_SMS. Grant it under Settings › Apps › SMS Gateway › Permissions.',
      );
      return;
    }

    if (permission.missing.length > 0) {
      appendLog({
        id: Date.now(),
        at: new Date(),
        level: 'warn',
        text: `Running without: ${permission.missing.join(', ')}`,
      });
    }

    const info = await native.getDeviceInfo();
    setDevice(info);

    // Re-read the SIMs now that permission has (just) been granted - the first
    // read on load may have returned nothing.
    setSims(await native.getSimCards());

    if (!info.canSendSms) {
      Alert.alert(
        'No SIM ready',
        'Permission is granted, but no SIM is ready. The gateway will connect and report itself DEGRADED; the server will not dispatch to it until a SIM appears.',
      );
    }

    // Hand off to the native connection: the socket, register, heartbeat, reconnect
    // and sending all run in Kotlin from here, on the foreground service's own
    // thread, so none of it depends on this JS runtime staying awake.
    counts.current = { sent: 0, failed: 0 };
    setStatus({ ...IDLE_STATUS, state: 'connecting' });
    native.startGateway({
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      deviceId: config.deviceId,
      deviceName: config.deviceName || info.deviceName,
      simLabels: config.simLabels,
    });

    // Remember that the gateway is meant to be running, so a relaunch reconnects
    // on its own instead of waiting for someone to press Start again.
    void saveConfig({ autoStart: true });

    // Nudge for the background-activity exemption - the thing that actually keeps
    // it alive with the screen off. Non-blocking: we are already connecting.
    const ignoring = await native.isIgnoringBatteryOptimizations().catch(() => true);
    setBatteryOk(ignoring);
    if (!ignoring) {
      Alert.alert(
        'Keep the gateway running',
        'To stay connected when the app is closed or the screen is off, allow this app to run in the background (ignore battery optimisation).',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Allow', onPress: () => native.requestDisableBatteryOptimization() },
        ],
      );
    }
  }, [config, appendLog]);

  const stop = useCallback(() => {
    native.stopService();
    counts.current = { sent: 0, failed: 0 };
    setStatus(IDLE_STATUS);
    // The operator stopped it on purpose - do not auto-reconnect on next launch.
    void saveConfig({ autoStart: false });
  }, []);

  // Auto-start once when the app relaunches already paired and set to run. This is
  // what makes "reopen the app and it's back online" work without pressing Start.
  useEffect(() => {
    if (autoStarted.current) return;
    if (config && config.autoStart && isConfigured(config) && status.state === 'idle') {
      autoStarted.current = true;
      void start();
    }
  }, [config, status.state, start]);

  // Re-check the background-activity exemption whenever the app returns to the
  // foreground - so it updates the moment the user comes back from granting it in
  // the system dialog.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        native.isIgnoringBatteryOptimizations().then(setBatteryOk).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  const fixBackground = useCallback(() => {
    native.requestDisableBatteryOptimization();
  }, []);

  const openAutoStart = useCallback(() => {
    native.openAutoStartSettings();
  }, []);

  const save = useCallback(async () => {
    await saveConfig({ serverUrl, apiKey, deviceName, simLabels });
    const reloaded = await loadConfig();
    setConfig(reloaded);
    setSimLabels(reloaded.simLabels);

    // saveConfig drops any SIM label that is not valid E.164. If the operator
    // typed something into a slot and it did not survive, say so rather than
    // silently showing a blank "from".
    const typed = Object.values(simLabels).filter((v) => v.trim().length > 0).length;
    const kept = Object.keys(reloaded.simLabels).length;
    if (typed > kept) {
      Alert.alert(
        'Some SIM numbers not saved',
        'A number must be E.164 — a leading +, then the country code, e.g. +919876543210. The rest was saved.',
      );
      return;
    }

    Alert.alert('Saved', 'Pairing details stored. Press Start to connect.');
  }, [serverUrl, apiKey, deviceName, simLabels]);

  /**
   * Fires a message through the whole real pipeline.
   *
   * It posts to the server, which dispatches back down the WebSocket to THIS
   * phone, which hands it to the SIM. So a green result here means every link
   * works - not just the radio. That is why it does not shortcut to SmsManager.
   */
  const sendTest = useCallback(async () => {
    if (!config) return;

    const to = normaliseNumber(testTo);

    if (!to) {
      Alert.alert(
        'Not a valid number',
        'Use E.164: a leading +, then the country code, e.g. +919876543210. The server refuses to guess a country code.',
      );
      return;
    }

    if (testBody.trim().length === 0) {
      Alert.alert('Empty message', 'Type something to send.');
      return;
    }

    setSending(true);

    try {
      const result = await sendTestSms(config, to, testBody);

      appendLog({
        id: Date.now(),
        at: new Date(),
        level: 'info',
        text: `Test accepted: ${result.status}, ${result.partCount} part(s)${
          result.isUnicode ? ' (Unicode)' : ''
        }`,
      });

      if (!result.dispatched) {
        // The server took it but had nobody to hand it to. Almost always: the
        // gateway is not started. Say so, rather than leaving the user watching a
        // history row sit at QUEUED forever.
        Alert.alert(
          'Accepted, but not sent yet',
          'No gateway was connected, so the message is QUEUED. Press "Start gateway" and it will be delivered to this phone automatically.',
        );
        return;
      }

      Alert.alert(
        'Sent to this phone',
        `The server dispatched it back to this handset (${result.partCount} SMS part${
          result.partCount === 1 ? '' : 's'
        }). Watch the History below go SENDING → SENT → DELIVERED.`,
      );
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : // A bare fetch failure is almost always the URL or the network, and the
            // message TypeScript gives us ("Network request failed") says nothing.
            'Could not reach the server. Check the Server URL and that this phone is on the same network.';

      appendLog({ id: Date.now(), at: new Date(), level: 'error', text: `Test failed: ${message}` });
      Alert.alert('Could not send', message);
    } finally {
      setSending(false);
    }
  }, [config, testTo, testBody, appendLog]);

  const wipeHistory = useCallback(() => {
    Alert.alert('Clear history?', 'This only clears what is stored on this phone. The server keeps its own records.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await clearHistory();
            setHistory([]);
          })();
        },
      },
    ]);
  }, []);

  if (!config) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.loading}>
          <ActivityIndicator size="large" />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  const running = status.state !== 'idle';
  const ready = isConfigured(config);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>SMS Gateway</Text>
          <Text style={styles.subtitle}>This phone is the modem.</Text>

          <StatusCard status={status} device={device} />

          <View style={styles.card}>
            <Text style={styles.cardTitle}>BACKGROUND</Text>

            {batteryOk === true ? (
              <Text style={styles.bgOk}>✓ Allowed to run in the background.</Text>
            ) : batteryOk === false ? (
              <Text style={styles.warning}>
                ⚠ Not allowed to run in the background — the gateway will drop offline when the
                app is closed or the screen turns off. Fix it below, then keep the phone plugged in.
              </Text>
            ) : (
              <Text style={styles.hint}>Checking…</Text>
            )}

            <View style={styles.bgActions}>
              <Pressable style={[styles.button, styles.secondary, styles.bgBtn]} onPress={fixBackground}>
                <Text style={styles.secondaryText}>1. Allow background</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.secondary, styles.bgBtn]} onPress={openAutoStart}>
                <Text style={styles.secondaryText}>2. Auto-start</Text>
              </Pressable>
            </View>

            <Text style={styles.hint}>
              Tap both, then keep the phone plugged in. &quot;Allow background&quot; covers
              Samsung &amp; Pixel; &quot;Auto-start&quot; opens the extra toggle that
              Xiaomi/Redmi, Oppo/Realme, Vivo, OnePlus and Huawei also need. On those phones,
              also lock the app in Recents (open Recent apps, then lock/pin its card).
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>PAIRING</Text>

            <Field
              label="Server URL"
              value={serverUrl}
              onChange={setServerUrl}
              placeholder="http://192.168.1.5:4000"
              editable={!running}
              autoCapitalize="none"
              keyboardType="url"
            />

            <Field
              label="API key — must carry the gateway:connect scope"
              value={apiKey}
              onChange={setApiKey}
              placeholder="sk_…"
              editable={!running}
              autoCapitalize="none"
              secureTextEntry
            />

            <Field
              label="Device name"
              value={deviceName}
              onChange={setDeviceName}
              placeholder="Reception phone"
              editable={!running}
            />

            {/*
              One row per SIM. This is what turns a dual-SIM phone into two
              gateway numbers: each SIM gets its own number label, and the server
              routes and caps them independently.
            */}
            <Text style={styles.fieldLabel}>SIM numbers — shown as the sender</Text>
            {sims.length === 0 ? (
              <Text style={styles.hint}>
                No SIM detected yet. Grant the phone permission and press Start; the SIMs will appear
                here to label.
              </Text>
            ) : (
              sims.map((sim) => (
                <View key={sim.subscriptionId} style={styles.simRow}>
                  <Text style={styles.simTag}>
                    SIM {sim.slot}
                    {sim.carrier ? ` · ${sim.carrier}` : ''}
                  </Text>
                  <TextInput
                    style={[styles.input, running && styles.inputDisabled]}
                    value={simLabels[String(sim.subscriptionId)] ?? ''}
                    onChangeText={(value) =>
                      setSimLabels((current) => ({ ...current, [String(sim.subscriptionId)]: value }))
                    }
                    placeholder="+919876543210"
                    placeholderTextColor="#9ca3af"
                    editable={!running}
                    keyboardType="phone-pad"
                    autoCorrect={false}
                  />
                </View>
              ))
            )}
            <Text style={styles.hint}>
              Android usually cannot read a SIM&apos;s own number, so type each one. It is only a
              label for the &quot;from&quot; column — nothing verifies it.
            </Text>

            {/*
              Cleartext is permitted (see network_security_config.xml), because a
              self-hosted server is usually a LAN box with no certificate. But the
              API key and every message body then travel unencrypted, so say so
              rather than letting it pass silently.
            */}
            {serverUrl.length > 0 && !/^https:/i.test(serverUrl) ? (
              <Text style={styles.warning}>
                Not HTTPS — the API key and message bodies are sent unencrypted. Fine on a trusted
                LAN; use https:// over the internet.
              </Text>
            ) : null}

            <Text style={styles.hint}>Device ID: {config.deviceId}</Text>

            <Pressable
              style={[styles.button, styles.secondary, running && styles.disabled]}
              onPress={() => void save()}
              disabled={running}>
              <Text style={styles.secondaryText}>Save</Text>
            </Pressable>
          </View>

          {running ? (
            <Pressable style={[styles.button, styles.stop]} onPress={stop}>
              <Text style={styles.buttonText}>Stop gateway</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.button, styles.start, !ready && styles.disabled]}
              onPress={() => void start()}
              disabled={!ready}>
              <Text style={styles.buttonText}>Start gateway</Text>
            </Pressable>
          )}

          {!ready && <Text style={styles.warning}>Enter a server URL and API key, then Save.</Text>}

          {/*
            The test panel. Posts to the server, which dispatches back down the
            WebSocket to this same phone - so it exercises the entire pipeline,
            not just the radio.
          */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>SEND A TEST MESSAGE</Text>

            <Field
              label="To"
              value={testTo}
              onChange={setTestTo}
              placeholder="+919876543210"
              keyboardType="phone-pad"
              editable={!sending}
            />

            <Field
              label="Message"
              value={testBody}
              onChange={setTestBody}
              placeholder="Test from the SMS gateway."
              editable={!sending}
              multiline
              numberOfLines={3}
              style={[styles.input, styles.multiline]}
            />

            <Pressable
              style={[styles.button, styles.send, (!ready || sending) && styles.disabled]}
              onPress={() => void sendTest()}
              disabled={!ready || sending}>
              {sending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>Send test message</Text>
              )}
            </Pressable>

            <Text style={styles.hint}>
              {status.state === 'online'
                ? 'Goes through the server and back to this phone — so it tests the whole chain, not just the SIM.'
                : 'Start the gateway first, or the server will accept the message and leave it QUEUED with no phone to send it.'}
            </Text>
          </View>

          {/* History: one row per SMS, persisted. Survives restarts, unlike the log. */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>MESSAGE HISTORY</Text>
              {history.length > 0 ? (
                <Pressable onPress={wipeHistory} hitSlop={8}>
                  <Text style={styles.clear}>Clear</Text>
                </Pressable>
              ) : null}
            </View>

            {history.length === 0 ? (
              <Text style={styles.hint}>
                No messages yet. Anything this phone sends will appear here — and stay here after a
                restart.
              </Text>
            ) : (
              history.map((entry) => <HistoryRow key={entry.id} entry={entry} />)
            )}
          </View>

          {/* Activity: an event stream for debugging the connection. Ephemeral. */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>ACTIVITY</Text>

            {logs.length === 0 ? (
              <Text style={styles.hint}>Nothing yet.</Text>
            ) : (
              logs.map((entry) => (
                <View key={entry.id} style={styles.logRow}>
                  <Text style={styles.logTime}>
                    {entry.at.toLocaleTimeString([], { hour12: false })}
                  </Text>
                  <Text style={[styles.logText, styles[entry.level]]}>{entry.text}</Text>
                </View>
              ))
            )}
          </View>

          <Text style={styles.footnote}>
            Keep this phone plugged in. Android throttles a gateway on a low battery, and the server
            will mark it offline.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------

function StatusCard({
  status,
  device,
}: {
  status: GatewayStatus;
  device: DeviceInfo | null;
}): React.JSX.Element {
  const colour: string = {
    idle: '#6b7280',
    connecting: '#d97706',
    reconnecting: '#d97706',
    online: '#059669',
    error: '#dc2626',
  }[status.state];

  const label: string = {
    idle: 'Stopped',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    online: 'Online',
    error: 'Error',
  }[status.state];

  return (
    <View style={styles.card}>
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: colour }]} />
        <Text style={[styles.statusLabel, { color: colour }]}>{label}</Text>
      </View>

      {status.detail ? <Text style={styles.detail}>{status.detail}</Text> : null}

      {device && !device.canSendSms ? (
        <Text style={styles.warning}>Cannot send: SEND_SMS is not granted, or no SIM is ready.</Text>
      ) : null}

      <View style={styles.stats}>
        <Stat label="Sent" value={String(status.sentCount)} />
        <Stat label="Failed" value={String(status.failedCount)} />
        <Stat label="Battery" value={device && device.batteryLevel >= 0 ? `${device.batteryLevel}%` : '—'} />
        <Stat label="SIM" value={device?.simOperator ?? '—'} />
      </View>
    </View>
  );
}

/**
 * One SMS: who it came from, who it went to, and what became of it.
 *
 * The four statuses are shown as distinct colours because they mean genuinely
 * different things, and collapsing them would hide the one distinction that
 * matters most: SENT means the message left this handset; DELIVERED means the
 * carrier confirmed it arrived. A message can sit at SENT forever on a network
 * that does not return delivery reports, and that is not a failure.
 */
function HistoryRow({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  const colour = {
    SENDING: '#d97706',
    SENT: '#2563eb',
    DELIVERED: '#059669',
    FAILED: '#dc2626',
  }[entry.status];

  const when = new Date(entry.at);

  return (
    <View style={styles.historyRow}>
      <View style={styles.historyTop}>
        <Text style={[styles.badge, { color: colour, borderColor: colour }]}>{entry.status}</Text>
        <Text style={styles.historyTime}>
          {when.toLocaleDateString()} {when.toLocaleTimeString([], { hour12: false })}
        </Text>
      </View>

      <View style={styles.historyRoute}>
        <Text style={styles.historyLabel}>From</Text>
        {/* An unknown sender is stated, not left blank - a blank cell reads as a bug. */}
        <Text style={styles.historyNumber}>{entry.from ?? 'unknown SIM'}</Text>
      </View>

      <View style={styles.historyRoute}>
        <Text style={styles.historyLabel}>To</Text>
        <Text style={styles.historyNumber}>{entry.to}</Text>
      </View>

      <Text style={styles.historyBody} numberOfLines={3}>
        {entry.body}
      </Text>

      {entry.errorCode ? (
        <Text style={styles.historyError}>
          {entry.errorCode}
          {entry.errorMessage ? ` — ${entry.errorMessage}` : ''}
        </Text>
      ) : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/**
 * `onChange` is deliberately Omit-ed from the inherited TextInput props.
 *
 * TextInput already HAS an `onChange`, and it takes a change *event*, not a
 * string. Leaving it in the intersection makes our `(value: string) => void`
 * collide with it, and TypeScript resolves that to a function that must accept
 * both - which nothing can. Omitting the ones we redefine is the fix; the
 * alternative (casting) would just hide the clash until runtime.
 */
type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  editable?: boolean;
} & Omit<React.ComponentProps<typeof TextInput>, 'onChange' | 'value' | 'editable'>;

function Field({ label, value, onChange, editable = true, ...rest }: FieldProps): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, !editable && styles.inputDisabled]}
        value={value}
        onChangeText={onChange}
        placeholderTextColor="#9ca3af"
        editable={editable}
        autoCorrect={false}
        {...rest}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9fafb' },
  screen: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, paddingBottom: 48 },

  title: { fontSize: 28, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 14, color: '#6b7280', marginBottom: 20 },

  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardTitle: { fontSize: 11, fontWeight: '700', color: '#9ca3af', marginBottom: 12, letterSpacing: 1 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  clear: { fontSize: 12, color: '#dc2626', fontWeight: '600' },

  historyRow: {
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingTop: 10,
    paddingBottom: 10,
  },
  historyTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: {
    fontSize: 10,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  historyTime: { fontSize: 11, color: '#9ca3af' },
  historyRoute: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  historyLabel: { fontSize: 11, color: '#9ca3af', width: 36 },
  historyNumber: { fontSize: 14, color: '#111827', fontWeight: '600' },
  historyBody: { fontSize: 13, color: '#4b5563', marginTop: 8 },
  historyError: { fontSize: 12, color: '#dc2626', marginTop: 6 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusLabel: { fontSize: 20, fontWeight: '700' },
  detail: { fontSize: 13, color: '#6b7280', marginTop: 6 },

  stats: { flexDirection: 'row', marginTop: 16, gap: 8 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 16, fontWeight: '700', color: '#111827' },
  statLabel: { fontSize: 11, color: '#9ca3af', marginTop: 2 },

  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  simRow: { marginBottom: 8 },
  simTag: { fontSize: 11, color: '#2563eb', fontWeight: '600', marginBottom: 3 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  inputDisabled: { backgroundColor: '#f3f4f6', color: '#6b7280' },

  button: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginBottom: 12 },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  start: { backgroundColor: '#059669' },
  stop: { backgroundColor: '#dc2626' },
  send: { backgroundColor: '#2563eb', marginTop: 4, marginBottom: 8 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  secondary: { backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#d1d5db', marginBottom: 0 },
  secondaryText: { color: '#374151', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },

  hint: { fontSize: 12, color: '#9ca3af', marginBottom: 12 },
  warning: { fontSize: 13, color: '#b45309', marginTop: 8, marginBottom: 4 },
  bgOk: { fontSize: 13, color: '#059669', fontWeight: '600', marginBottom: 4 },
  bgActions: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 6 },
  bgBtn: { flex: 1, marginBottom: 0, paddingVertical: 10 },
  footnote: { fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 8 },

  logRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  logTime: { fontSize: 11, color: '#9ca3af' },
  logText: { fontSize: 12, flex: 1 },
  info: { color: '#374151' },
  warn: { color: '#b45309' },
  error: { color: '#dc2626' },
});
