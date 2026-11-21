'use strict';

/*
 * SMS Gateway admin panel.
 *
 * Vanilla JS on purpose - no build step, no framework, one file the backend
 * serves directly. It is CSP-safe: no eval, no inline handlers, and all data goes
 * into the DOM via textContent (never innerHTML), so a message body containing
 * "<script>" is shown as text, never executed. That last point matters here more
 * than usual: message bodies come from whoever called the send API, which could be
 * any app holding an API key.
 */

const ACCESS = 'sms_gw_access';
const REFRESH = 'sms_gw_refresh';

// ---------------------------------------------------------------------------
// Tiny DOM helper. Builds elements with textContent, never innerHTML.
// ---------------------------------------------------------------------------
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function $(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// API client. Adds the bearer token, and transparently refreshes it once on a
// 401 before giving up and bouncing back to the login screen.
// ---------------------------------------------------------------------------
async function api(path, options = {}, retry = true) {
  // A FormData body (file upload) must NOT carry a JSON content-type: the browser
  // sets its own multipart boundary, and overriding it makes the server unable to
  // parse the parts. For everything else we default to JSON.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = Object.assign(isForm ? {} : { 'Content-Type': 'application/json' }, options.headers || {});
  const token = localStorage.getItem(ACCESS);
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch('/api' + path, Object.assign({}, options, { headers }));

  if (res.status === 401 && retry && localStorage.getItem(REFRESH)) {
    // The 15-minute access token expired. Trade the refresh token for a new pair
    // and replay the original request exactly once. A second failure means the
    // refresh token is dead too, and the only honest thing to do is re-login.
    const refreshed = await tryRefresh();
    if (refreshed) return api(path, options, false);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok || body.success === false) {
    const message = (body.error && body.error.message) || 'Request failed (' + res.status + ')';
    const err = new Error(message);
    err.code = (body.error && body.error.code) || 'HTTP_' + res.status;
    err.status = res.status;
    throw err;
  }

  return body;
}

async function tryRefresh() {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: localStorage.getItem(REFRESH) }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) return false;

    const tokens = body.data.tokens || body.data;
    localStorage.setItem(ACCESS, tokens.accessToken);
    if (tokens.refreshToken) localStorage.setItem(REFRESH, tokens.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function logout() {
  localStorage.removeItem(ACCESS);
  localStorage.removeItem(REFRESH);
  stopPhonePolling();
  stopCampaignPolling();
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const errBox = $('login-error');
  errBox.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('login-email').value.trim(),
        password: $('login-password').value,
      }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error((body.error && body.error.message) || 'Login failed');
    }

    const tokens = body.data.tokens;
    localStorage.setItem(ACCESS, tokens.accessToken);
    localStorage.setItem(REFRESH, tokens.refreshToken);
    enterApp(body.data.user);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('logout-btn').addEventListener('click', logout);

let currentUser = null;

function enterApp(user) {
  currentUser = user || null;
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('whoami').textContent = user ? user.email : '';
  showTab('phones');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabButtons = Array.from(document.querySelectorAll('.tab'));

for (const btn of tabButtons) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}

function showTab(name) {
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('hidden', panel.id !== 'tab-' + name);
  }

  // Leaving any tab: stop every background poller, then start only the one this
  // tab needs. Otherwise a stale timer keeps hitting the API from a hidden tab.
  stopPhonePolling();
  stopCampaignPolling();

  if (name === 'phones') startPhonePolling();
  if (name === 'messages') loadMessages();
  if (name === 'send') populateSendFrom();
  if (name === 'campaigns') {
    populateCampaignFrom();
    startCampaignPolling();
  }
  if (name === 'keys') loadKeys();
  if (name === 'account') fillAccount();
}

// ---------------------------------------------------------------------------
// Phones — live, auto-refreshing
// ---------------------------------------------------------------------------
let phoneTimer = null;

function startPhonePolling() {
  loadPhones();
  // 5s: fast enough to feel live, slow enough to be nothing on the server.
  phoneTimer = setInterval(loadPhones, 5000);
}
function stopPhonePolling() {
  if (phoneTimer) clearInterval(phoneTimer);
  phoneTimer = null;
}

$('phones-date').addEventListener('change', () => loadPhones());
$('phones-today').addEventListener('click', () => {
  // Cleared, not set to the browser's today: an empty value means "whatever the
  // server calls today", and the server is the one that knows the configured
  // timezone the daily caps actually roll over in.
  $('phones-date').value = '';
  loadPhones();
});

/**
 * The day the SIM figures are for, as YYYY-MM-DD in the operator's own timezone.
 *
 * Empty means "today", and today is resolved by the SERVER rather than pinned
 * here - otherwise a panel left open overnight would keep asking for yesterday.
 */
function selectedPhoneDay() {
  const input = $('phones-date');
  return input && input.value ? input.value : '';
}

async function loadPhones() {
  try {
    const day = selectedPhoneDay();
    const { data } = await api('/gateways' + (day ? '?date=' + encodeURIComponent(day) : ''));

    // Keep the picker showing whichever day the figures are actually for, so the
    // control never disagrees with the numbers underneath it.
    const input = $('phones-date');
    if (input && !input.value && data.date) input.value = data.date;

    renderPhoneTotals(data);
    renderPhones(data.gateways || []);
  } catch (err) {
    if (err.status === 401) logout();
  }
}

/** The fleet's day at a glance: what actually went out, and what it cost the caps. */
function renderPhoneTotals(data) {
  const box = $('phones-totals');
  if (!box) return;
  box.textContent = '';

  const gateways = data.gateways || [];
  let sent = 0;
  let failed = 0;
  let pending = 0;
  let used = 0;
  let capacity = 0;

  for (const g of gateways) {
    for (const s of g.sims || []) {
      sent += s.sentToday || 0;
      failed += s.failedToday || 0;
      pending += s.pendingToday || 0;
      used += s.usedToday || 0;
      capacity += s.dailyLimit || 0;
    }
  }

  const isToday = data.date === new Date().toLocaleDateString('en-CA');
  const label = isToday ? 'Today' : data.date;

  box.appendChild(el('span', { class: 'day-label', text: label }));
  box.appendChild(el('span', { class: 'tot tot-sent', text: '✓ ' + sent + ' sent' }));
  box.appendChild(el('span', { class: 'tot tot-failed', text: '✗ ' + failed + ' failed' }));
  if (pending) box.appendChild(el('span', { class: 'tot tot-pending', text: '· ' + pending + ' in flight' }));
  box.appendChild(
    el('span', { class: 'tot tot-cap', text: used + ' / ' + capacity + ' parts of the daily SIM capacity' }),
  );
}

function renderPhones(gateways) {
  const list = $('phones-list');
  list.textContent = '';

  if (!gateways.length) {
    list.appendChild(el('div', { class: 'empty', text: 'No phones have connected yet.' }));
    return;
  }

  for (const g of gateways) {
    const card = el('div', { class: 'card' });

    const top = el('div', { class: 'card-top' }, [
      el('span', { class: 'card-name', text: g.deviceName || 'Unnamed phone' }),
      el('span', { class: 'status-' + g.status }, [
        el('span', { class: 'dot' }),
        document.createTextNode(g.connected ? g.status : 'OFFLINE'),
      ]),
    ]);
    card.appendChild(top);

    const battery = g.batteryLevel == null ? '—' : g.batteryLevel + '%' + (g.isCharging ? ' ⚡' : '');
    card.appendChild(el('div', { class: 'meta-row', text: 'Battery ' + battery + '  ·  Android ' + (g.androidVersion || '?') }));
    if (g.lastSeenAt) {
      card.appendChild(el('div', { class: 'meta-row', text: 'Last seen ' + timeAgo(g.lastSeenAt) }));
    }

    const sims = g.sims || [];
    if (sims.length) {
      const simWrap = el('div', { class: 'sim' });
      for (const s of sims) {
        const used = s.usedToday || 0;
        const limit = s.dailyLimit || 100;
        const pct = Math.min(100, Math.round((used / limit) * 100));

        const fill = el('span');
        fill.style.width = pct + '%';
        if (pct >= 100) fill.className = 'full';
        else if (pct >= 80) fill.className = 'warn';

        simWrap.appendChild(
          el('div', { class: 'sim-line' }, [
            el('span', { class: 'sim-num', text: s.phoneNumber || 'SIM ' + s.slot + ' (unlabelled)' }),
            el('span', { class: 'quota' + (pct >= 100 ? ' high' : ''), text: used + ' / ' + limit }),
          ]),
        );
        simWrap.appendChild(el('div', { class: 'bar' }, [fill]));

        // What this SIM actually did on the selected day. Read from the message
        // history, so it is a record rather than a live counter: it survives a
        // backend restart, and asking for a past date shows that day's real work.
        const sent = s.sentToday || 0;
        const failed = s.failedToday || 0;
        const inFlight = s.pendingToday || 0;

        const counts = el('div', { class: 'sim-counts' }, [
          el('span', { class: 'c-sent', text: '✓ ' + sent + ' sent' }),
          el('span', { class: 'c-failed' + (failed ? ' bad' : ''), text: '✗ ' + failed + ' failed' }),
        ]);
        if (inFlight) counts.appendChild(el('span', { class: 'c-pending', text: '· ' + inFlight + ' in flight' }));
        // Only worth saying when it differs from the message count: a long SMS is
        // billed - and capped - as several parts, which is why the bar above can
        // read higher than the number of messages sent.
        if (used !== sent + failed + inFlight) {
          counts.appendChild(el('span', { class: 'c-parts', text: used + ' parts' }));
        }
        simWrap.appendChild(counts);
      }
      card.appendChild(simWrap);
    }

    // Call log / SMS: only for a CONNECTED phone, because the data lives on the
    // handset and is fetched live over its socket - there is nothing to show for a
    // phone that is offline.
    if (g.connected) {
      const actions = el('div', { class: 'card-actions' });
      const callBtn = el('button', { class: 'btn btn-ghost', text: '📞 Call log' });
      callBtn.addEventListener('click', () => showDeviceData(g.id, g.deviceName || 'phone', 'call-log'));
      const smsBtn = el('button', { class: 'btn btn-ghost', text: '💬 SMS' });
      smsBtn.addEventListener('click', () => showDeviceData(g.id, g.deviceName || 'phone', 'sms'));
      actions.appendChild(callBtn);
      actions.appendChild(smsBtn);
      card.appendChild(actions);
    }

    // Remove is offered only for a phone that is NOT currently connected: a live
    // phone re-registers on its next heartbeat, so the backend refuses to delete
    // it anyway. This is how you clear a stale duplicate (e.g. after a reinstall
    // minted a new device id).
    if (!g.connected) {
      const rm = el('button', { class: 'btn btn-danger card-remove', text: 'Remove' });
      rm.addEventListener('click', () => deletePhone(g.id, g.deviceName || 'this phone'));
      card.appendChild(rm);
    }

    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Per-phone call log / SMS viewer (fetched live from the handset)
// ---------------------------------------------------------------------------
function openModal(title, bodyNode) {
  $('modal-title').textContent = title;
  setModalBody(bodyNode);
  $('modal').classList.remove('hidden');
}
function setModalBody(node) {
  const body = $('modal-body');
  body.textContent = '';
  if (node) body.appendChild(node);
}
function closeModal() {
  $('modal').classList.add('hidden');
}
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => {
  // Click on the dark backdrop (not the card) closes it.
  if (e.target === $('modal')) closeModal();
});

async function showDeviceData(id, name, kind) {
  const title = (kind === 'sms' ? '💬 Messages' : '📞 Call log') + ' — ' + name;
  openModal(title, el('div', { class: 'modal-loading', text: 'Requesting from the phone…' }));

  try {
    const path = '/gateways/' + id + (kind === 'sms' ? '/sms' : '/call-log');
    const { data } = await api(path);

    if (!data.granted) {
      setModalBody(
        el('div', { class: 'empty', text:
          'The phone has not granted ' + (kind === 'sms' ? 'SMS' : 'call-log') +
          ' access. On that phone, open the SMS Gateway app and grant the permission, then try again.' }),
      );
      return;
    }

    setModalBody(kind === 'sms' ? renderSmsList(data.messages) : renderCallList(data.entries));
  } catch (err) {
    setModalBody(el('div', { class: 'result bad', text: err.message }));
  }
}

function dirIcon(dir) {
  return { incoming: '↙', outgoing: '↗', missed: '⤬', rejected: '⊘', blocked: '⊘', voicemail: '☎' }[dir] || '•';
}
function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? m + 'm ' + s + 's' : s + 's';
}

function renderCallList(entries) {
  if (!entries || !entries.length) return el('div', { class: 'empty', text: 'No calls on this phone.' });

  const wrap = el('div', { class: 'data-list' });
  for (const c of entries) {
    const dir = c.direction || 'unknown';
    const sub = [];
    if (c.number && c.name) sub.push(c.number);
    sub.push(dir);
    if (c.durationSec) sub.push(formatDuration(c.durationSec));
    sub.push(shortTime(c.timestamp));

    wrap.appendChild(
      el('div', { class: 'data-row' }, [
        el('div', { class: 'data-main' }, [
          el('span', { class: 'call-dir call-' + dir, text: dirIcon(dir) }),
          el('span', { class: 'data-num', text: c.name || c.number || 'Unknown' }),
        ]),
        el('div', { class: 'data-sub', text: sub.join(' · ') }),
      ]),
    );
  }
  return wrap;
}

function renderSmsList(messages) {
  if (!messages || !messages.length) return el('div', { class: 'empty', text: 'No messages on this phone.' });

  const wrap = el('div', { class: 'data-list' });
  for (const m of messages) {
    wrap.appendChild(
      el('div', { class: 'data-row' }, [
        el('div', { class: 'data-main' }, [
          el('span', { class: 'sms-box box-' + m.box, text: m.box }),
          el('span', { class: 'data-num', text: m.address || 'Unknown' }),
          el('span', { class: 'data-time', text: shortTime(m.timestamp) }),
        ]),
        el('div', { class: 'data-body', text: m.body }),
      ]),
    );
  }
  return wrap;
}

async function deletePhone(id, name) {
  if (!confirm('Remove “' + name + '”? This deletes its record. If the phone reconnects later, it will reappear.')) {
    return;
  }
  try {
    await api('/gateways/' + id, { method: 'DELETE' });
    loadPhones();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// Messages — filter, search, paginate
// ---------------------------------------------------------------------------
let msgPage = 1;
const MSG_LIMIT = 20;

$('msg-refresh').addEventListener('click', () => {
  msgPage = 1;
  loadMessages();
});
$('msg-status').addEventListener('change', () => {
  msgPage = 1;
  loadMessages();
});
let searchDebounce = null;
$('msg-search').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    msgPage = 1;
    loadMessages();
  }, 300);
});
$('msg-prev').addEventListener('click', () => {
  if (msgPage > 1) {
    msgPage -= 1;
    loadMessages();
  }
});
$('msg-next').addEventListener('click', () => {
  msgPage += 1;
  loadMessages();
});

async function loadMessages() {
  const params = new URLSearchParams({ page: String(msgPage), limit: String(MSG_LIMIT) });
  const status = $('msg-status').value;
  const search = $('msg-search').value.trim();
  if (status) params.set('status', status);
  if (search) params.set('search', search);

  try {
    const res = await api('/sms?' + params.toString());
    renderMessages(res.data, res.meta || {});
  } catch (err) {
    if (err.status === 401) logout();
  }
}

function renderMessages(messages, meta) {
  const body = $('messages-body');
  body.textContent = '';

  if (!messages.length) {
    const row = el('tr', {}, [el('td', { class: 'empty', attrs: { colspan: '6' }, text: 'No messages.' })]);
    body.appendChild(row);
  } else {
    for (const m of messages) {
      body.appendChild(
        el('tr', {}, [
          el('td', { text: shortTime(m.createdAt || m.queuedAt) }),
          el('td', { text: m.senderNumber || '—' }),
          el('td', { text: m.recipient }),
          el('td', { class: 'cell-body', text: m.body }),
          el('td', { text: String(m.partCount) + (m.isUnicode ? ' (U)' : '') }),
          el('td', {}, [el('span', { class: 'badge b-' + m.status, text: m.status })]),
        ]),
      );
    }
  }

  const total = meta.total != null ? meta.total : messages.length;
  const pages = meta.totalPages || 1;
  $('msg-page').textContent = 'Page ' + msgPage + ' of ' + pages + ' · ' + total + ' total';
  $('msg-prev').disabled = msgPage <= 1;
  $('msg-next').disabled = !meta.hasNext;
}

// ---------------------------------------------------------------------------
// Send test
// ---------------------------------------------------------------------------
// Fills a <select> with one option per connected, labelled SIM number, keeping
// its first (Auto) option in place. Shared by the Send-test and Campaign forms.
async function fillSimSelect(select) {
  select.length = 1;

  try {
    const { data } = await api('/gateways');
    const seen = new Set();
    for (const g of data.gateways || []) {
      if (!g.connected) continue;
      for (const s of g.sims || []) {
        if (s.phoneNumber && !seen.has(s.phoneNumber)) {
          seen.add(s.phoneNumber);
          const opt = el('option', { text: s.phoneNumber + '  (' + (g.deviceName || 'phone') + ')' });
          opt.value = s.phoneNumber;
          select.appendChild(opt);
        }
      }
    }
  } catch {
    /* leave just the Auto option */
  }
}

function populateSendFrom() {
  return fillSimSelect($('send-from'));
}

function populateCampaignFrom() {
  return fillSimSelect($('c-from'));
}

// ---------------------------------------------------------------------------
// Number normalisation.
//
// A deliberate port of normalizeToE164() in src/domain/campaign.ts - same rules,
// same order - so the panel and the campaign backend never disagree about what
// "9876543210" means. Keep the two in step if either changes.
//
// The /sms/send API itself refuses to guess a country code, and it is right to:
// guessing wrong sends someone's OTP to a stranger. But the operator picking
// "+91" in the box beside the field is an instruction, not a guess, so the panel
// resolves the number here and hands the API the finished E.164 string.
// ---------------------------------------------------------------------------
const E164_RE = /^\+[1-9]\d{7,14}$/;
const COUNTRY_CODE_RE = /^\+[1-9]\d{0,3}$/;

function normalizeToE164(raw, defaultCc) {
  const cleaned = String(raw).replace(/[\s()\-.]/g, '');
  if (!cleaned) return null;

  let candidate;
  if (cleaned.startsWith('+')) {
    candidate = cleaned;
  } else if (/^\d+$/.test(cleaned)) {
    // Strip a national trunk "0" (09876543210 -> 9876543210) before prefixing.
    const local = cleaned.replace(/^0+/, '');
    if (!local) return null;
    candidate = defaultCc + local;
  } else {
    return null;
  }

  return E164_RE.test(candidate) ? candidate : null;
}

/** The country code for the single-send form, falling back to +91 if emptied. */
function sendCountryCode() {
  const raw = $('send-country').value.trim();
  return COUNTRY_CODE_RE.test(raw) ? raw : '+91';
}

/**
 * Show what will actually be dialled, live. The operator types 10 digits; this
 * is where they see it become +919876543210 *before* committing to a send.
 */
function updateSendPreview() {
  const box = $('send-to-preview');
  const raw = $('send-to').value.trim();

  if (!raw) {
    box.classList.add('hidden');
    return;
  }

  const normalized = normalizeToE164(raw, sendCountryCode());
  box.textContent = normalized ? 'Will send to ' + normalized : 'Not a usable number: ' + raw;
  box.classList.remove('hidden');
}

$('send-to').addEventListener('input', updateSendPreview);
$('send-country').addEventListener('input', updateSendPreview);

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('send-btn');
  const out = $('send-result');
  out.classList.add('hidden');

  // Resolve before touching the network: a number we cannot salvage is a typo,
  // and saying so here beats a round trip to be told the same thing.
  const to = normalizeToE164($('send-to').value, sendCountryCode());
  if (!to) {
    out.className = 'result bad';
    out.textContent =
      'That does not look like a phone number. Enter a local number like 9876543210, or a full one like +919876543210.';
    out.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  const payload = { to: to, body: $('send-body').value };
  const from = $('send-from').value;
  if (from) payload.from = from;

  try {
    const res = await api('/sms/send', { method: 'POST', body: JSON.stringify(payload) });
    const dispatched = res.meta && res.meta.dispatched;
    out.className = 'result ok';
    out.textContent = dispatched
      ? 'Sent to a phone (' + res.data.partCount + ' part(s)). Check Messages for delivery.'
      : 'Accepted, but no phone was connected — it is queued and will send when one connects.';
    out.classList.remove('hidden');
  } catch (err) {
    out.className = 'result bad';
    out.textContent = err.message;
    out.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
});

// ---------------------------------------------------------------------------
// Campaigns — bulk send, one message to many numbers, paced automatically.
// ---------------------------------------------------------------------------
let campaignTimer = null;
// Campaign ids whose recipient list is expanded. The list endpoint omits
// recipients to stay light, so an expanded card fetches the detail on demand.
const expandedCampaigns = new Set();

// The uploaded sheet, plus the operator's reading of it: which column holds the
// numbers, and which columns feed which {variables} in the message.
//
// One file at a time, deliberately. Two sheets with different columns cannot be
// stacked into one variable map without guessing what the operator meant, so a
// new upload replaces the last rather than merging into it. The paste box is
// still there for extra bare numbers.
let sheet = null;

// Which uploaded row the preview is showing. Pageable, because the row that
// reveals a mapping mistake is rarely the first one.
let previewRow = 0;

function startCampaignPolling() {
  loadCampaigns();
  // 3s: progress bars move visibly without hammering the API.
  campaignTimer = setInterval(loadCampaigns, 3000);
}
function stopCampaignPolling() {
  if (campaignTimer) clearInterval(campaignTimer);
  campaignTimer = null;
}

// Upload an Excel/CSV file and read it as a TABLE - every column, with a header,
// a sample value and a suggested variable name. The server parses it (the browser
// cannot read .xlsx without a library) and guesses; the operator confirms below.
// Nothing sends until they do.
function setFileNote(text, kind) {
  const note = $('c-file-note');
  note.textContent = text || '';
  note.className = 'file-note' + (kind ? ' ' + kind : '');
  note.classList.toggle('hidden', !text);
}

async function uploadRecipientsFile(file) {
  setFileNote('Reading ' + file.name + '…', 'loading');

  try {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await api('/campaigns/parse-recipients', { method: 'POST', body: fd });

    const rows = data.rows || [];
    if (!rows.length) {
      setFileNote('No usable rows found in ' + file.name + '.', 'bad');
      return;
    }

    sheet = {
      filename: data.filename || file.name,
      rows,
      skipped: data.skipped || 0,
      truncated: !!data.truncated,
      // The server's guess at each column, with `role` mutated in place as the
      // operator changes the dropdowns. A column it could not name stays out of
      // the merge until they name it.
      columns: (data.columns || []).map((c) => ({
        index: c.index,
        header: c.header,
        sample: c.sample,
        key: c.key || '',
        role: c.role === 'phone' ? 'phone' : c.key ? 'variable' : 'ignore',
      })),
    };
    previewRow = 0;

    const bits = ['✓ ' + rows.length + ' row(s) from ' + sheet.filename + '.'];
    if (sheet.skipped) bits.push(sheet.skipped + ' row(s) had no phone number and were left out.');
    if (sheet.truncated) bits.push('The file was longer — only these were kept.');
    if (data.phoneColumn < 0) bits.push('No column looked like phone numbers — pick one below.');
    setFileNote(bits.join(' '), data.phoneColumn < 0 ? 'bad' : 'ok');

    renderSheet();
    renderVarChips();
    updatePreview();
  } catch (err) {
    setFileNote(err.message, 'bad');
  }
}

// ---------------------------------------------------------------------------
// The mapping - which column is the number, which columns are variables.
// ---------------------------------------------------------------------------

/** A deliberate port of normalizeVarKey() in src/domain/campaign.ts - the two must agree. */
function varKey(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
}

function braced(keys) {
  return keys.map((k) => '{' + k + '}').join(', ');
}

function phoneColumn() {
  if (!sheet) return null;
  return sheet.columns.find((c) => c.role === 'phone') || null;
}

function mappedColumns() {
  if (!sheet) return [];
  return sheet.columns.filter((c) => c.role === 'variable' && c.key);
}

/** The variables the message asks for - a port of extractPlaceholders(). */
function bodyVariables() {
  const out = [];
  const pattern = /\{\s*([A-Za-z][A-Za-z0-9 _.-]{0,39})\s*\}/g;
  let match;
  while ((match = pattern.exec($('c-body').value)) !== null) {
    const key = varKey(match[1]);
    if (key && out.indexOf(key) === -1) out.push(key);
  }
  return out;
}

/** One uploaded row as the variable map the API takes. Blank cells are left out. */
function rowVars(row) {
  const vars = {};
  for (const column of mappedColumns()) {
    const value = (row[column.index] || '').trim();
    if (value) vars[column.key] = value;
  }
  return vars;
}

function buildRecipientRows() {
  const phone = phoneColumn();
  if (!sheet || !phone) return [];
  return sheet.rows
    .map((row) => ({ phone: (row[phone.index] || '').trim(), vars: rowVars(row) }))
    .filter((r) => r.phone);
}

/** Drop text at the cursor in the message box - what every "Insert" button does. */
function insertAtCursor(text) {
  const ta = $('c-body');
  const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  updatePreview();
}

function chipButton(key) {
  return actionBtn('{' + key + '}', 'btn-ghost btn-sm', () => insertAtCursor('{' + key + '}'));
}

/** The insert-a-variable row above the preview: one chip per mapped column. */
function renderVarChips() {
  const box = $('c-vars');
  box.textContent = '';

  const columns = mappedColumns();
  if (!columns.length) {
    box.appendChild(
      el('span', {
        class: 'muted small',
        text: 'Upload a spreadsheet below — every column becomes a variable you can drop in here.',
      }),
    );
    // {name} is offered even with no file: it is the one variable with a fallback,
    // so a message using it still reads for a plain pasted list.
    box.appendChild(chipButton('name'));
    return;
  }

  box.appendChild(el('span', { class: 'muted small', text: 'Insert:' }));
  for (const column of columns) box.appendChild(chipButton(column.key));
}

/** One row of the column mapper: what the column is, and what it feeds. */
function renderColumnRow(column) {
  const row = el('div', { class: 'map-row' });

  row.appendChild(
    el('div', { class: 'map-col' }, [
      el('span', { class: 'map-header', text: column.header }),
      el('span', { class: 'map-sample', text: column.sample ? 'e.g. ' + column.sample : 'blank' }),
    ]),
  );

  const role = el('select', { class: 'map-role', attrs: { 'aria-label': 'What ' + column.header + ' is' } });
  const roles = [
    ['phone', 'Phone number'],
    ['variable', 'Variable'],
    ['ignore', 'Ignore'],
  ];
  for (const [value, label] of roles) {
    const option = el('option', { text: label });
    option.value = value;
    if (column.role === value) option.selected = true;
    role.appendChild(option);
  }
  role.addEventListener('change', () => {
    // Exactly one phone column: picking a new one demotes the old, so the campaign
    // can never be built from two competing number columns.
    if (role.value === 'phone') {
      for (const other of sheet.columns) if (other !== column && other.role === 'phone') other.role = 'ignore';
    }
    column.role = role.value;
    if (column.role === 'variable' && !column.key) {
      column.key = varKey(column.header) || 'column_' + (column.index + 1);
    }
    renderSheet();
    renderVarChips();
    updatePreview();
  });
  row.appendChild(role);

  if (column.role === 'variable') {
    const key = el('input', {
      class: 'map-key',
      attrs: { type: 'text', placeholder: 'variable name', 'aria-label': 'Variable name for ' + column.header },
    });
    key.value = column.key;
    key.addEventListener('change', () => {
      column.key = varKey(key.value);
      key.value = column.key;
      renderVarChips();
      updatePreview();
    });
    key.addEventListener('keydown', (e) => {
      // Enter in a text input submits the form it sits in - which here would mean
      // "create & start sending" to the whole list, mid-mapping. Commit the name
      // instead; the operator presses the button when they mean the button.
      if (e.key === 'Enter') {
        e.preventDefault();
        key.blur();
      }
    });
    row.appendChild(key);
    row.appendChild(actionBtn('Insert', 'btn-ghost btn-sm', () => insertAtCursor('{' + column.key + '}')));
  }

  return row;
}

/** The uploaded sheet: a head with the count, then one mapper row per column. */
function renderSheet() {
  const box = $('c-uploaded');
  box.textContent = '';

  if (!sheet) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  box.appendChild(
    el('div', { class: 'uploaded-head' }, [
      el('span', { text: sheet.rows.length + ' row(s) · ' + sheet.filename }),
      actionBtn('Remove', 'btn-ghost btn-sm', () => {
        sheet = null;
        renderSheet();
        renderVarChips();
        updatePreview();
        setFileNote('', '');
      }),
    ]),
  );

  box.appendChild(
    el('div', {
      class: 'map-hint',
      text: 'One column is the phone number. Every column you mark “Variable” can be dropped into the message.',
    }),
  );

  for (const column of sheet.columns) box.appendChild(renderColumnRow(column));
}

// ---------------------------------------------------------------------------
// The preview - the real message for a real row, before anything sends.
// ---------------------------------------------------------------------------

/**
 * A deliberate port of renderTemplate() in src/domain/campaign.ts - same fallback,
 * same 8-character name cut, same "leave it and report it" for a missing value. If
 * the two ever disagree, this is the half that is wrong: what the operator reads
 * here has to be what the phone sends.
 */
function fillTemplate(body, vars) {
  const missing = [];
  const filled = body.replace(/\{\s*([A-Za-z][A-Za-z0-9 _.-]{0,39})\s*\}/g, (whole, raw) => {
    const key = varKey(raw);
    if (!key) return whole;

    const value = (vars[key] || '').trim();
    if (value) return value.slice(0, key === 'name' ? 8 : 120).replace(/\s+$/, '');
    if (key === 'name') return 'there';

    if (missing.indexOf(key) === -1) missing.push(key);
    return whole;
  });
  return { body: filled, missing };
}

/** Everything worth telling the operator about this mapping, in plain words. */
function previewWarnings(wanted, missingHere) {
  const out = [];
  const keys = mappedColumns().map((c) => c.key);

  const unmapped = wanted.filter((k) => k !== 'name' && keys.indexOf(k) === -1);
  if (unmapped.length) out.push('No column feeds ' + braced(unmapped) + '. The campaign will be refused until one does.');

  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicates.length) {
    const unique = duplicates.filter((k, i) => duplicates.indexOf(k) === i);
    out.push('Two columns are both named ' + braced(unique) + '. Rename one — the last would win.');
  }

  const unused = keys.filter((k) => wanted.indexOf(k) === -1);
  if (unused.length) out.push('Mapped but not used in the message: ' + braced(unused) + '.');

  if (missingHere.length) out.push('This row has no value for ' + braced(missingHere) + ', so it would be skipped.');

  const required = wanted.filter((k) => k !== 'name');
  if (required.length && $('c-recipients').value.trim()) {
    out.push('Pasted numbers carry no values for ' + braced(required) + ', so they would all be skipped.');
  }

  // How much of the list that costs, which is the number worth knowing before
  // starting a send that runs for hours.
  const rows = sheet && phoneColumn() ? sheet.rows : [];
  const mapped = required.filter((k) => keys.indexOf(k) !== -1);
  if (rows.length && mapped.length) {
    const holes = rows.filter((row) => {
      const vars = rowVars(row);
      return mapped.some((k) => !vars[k]);
    }).length;
    if (holes) out.push(holes + ' of ' + rows.length + ' rows are missing a value and would be skipped.');
  }

  return out;
}

function updatePreview() {
  const preview = $('c-preview');
  preview.textContent = '';

  const body = $('c-body').value;
  const wanted = bodyVariables();
  if (!body.trim() || !wanted.length) {
    preview.classList.add('hidden');
    return;
  }
  preview.classList.remove('hidden');

  const rows = sheet && phoneColumn() ? sheet.rows : [];
  if (previewRow >= rows.length) previewRow = 0;
  const row = rows[previewRow];
  const rendered = fillTemplate(body, row ? rowVars(row) : {});

  const head = el('div', { class: 'tpl-preview-head' }, [
    el('span', {
      class: 'tpl-preview-label',
      text: row ? 'Row ' + (previewRow + 1) + ' of ' + rows.length : 'Preview',
    }),
  ]);
  if (rows.length > 1) {
    head.appendChild(
      actionBtn('Next row', 'btn-ghost btn-sm', () => {
        previewRow = (previewRow + 1) % rows.length;
        updatePreview();
      }),
    );
  }
  preview.appendChild(head);

  const phone = phoneColumn();
  if (row && phone) preview.appendChild(el('div', { class: 'tpl-preview-to', text: 'To ' + (row[phone.index] || '') }));

  preview.appendChild(el('div', { class: 'tpl-preview-body', text: rendered.body }));

  for (const warning of previewWarnings(wanted, rendered.missing)) {
    preview.appendChild(el('div', { class: 'tpl-preview-warn', text: warning }));
  }
}

$('c-body').addEventListener('input', updatePreview);
$('c-recipients').addEventListener('input', updatePreview);
renderVarChips();

$('c-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) uploadRecipientsFile(file);
  // Reset so picking the SAME file again still fires a change event.
  e.target.value = '';
});

// Drag-and-drop onto the dropzone. preventDefault on dragover is what makes the
// element a valid drop target; without it the browser just opens the file.
(function initDropzone() {
  const dz = $('c-dropzone');
  if (!dz) return;

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    }),
  );
  ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('dragover')));

  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) uploadRecipientsFile(file);
  });
})();

$('campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('c-btn');
  const out = $('c-result');
  out.classList.add('hidden');

  const fail = (message) => {
    out.className = 'result bad';
    out.textContent = message;
    out.classList.remove('hidden');
  };

  // Everything that can be caught here is caught here - the server checks the same
  // things, but an operator who has just uploaded 4,000 rows should not have to
  // wait for a round trip to be told they forgot to map a column.
  if (sheet && !phoneColumn()) {
    fail('Pick which column holds the phone numbers.');
    return;
  }

  const recipientRows = buildRecipientRows();
  const pasted = $('c-recipients').value.trim();
  if (!pasted && !recipientRows.length) {
    fail('Add at least one recipient — paste numbers, or upload a file.');
    return;
  }

  const keys = mappedColumns().map((c) => c.key);
  const unmapped = bodyVariables().filter((k) => k !== 'name' && keys.indexOf(k) === -1);
  if (unmapped.length) {
    fail('No column feeds ' + braced(unmapped) + '. Map a column to it, or remove the braces from the message.');
    return;
  }

  const payload = {
    name: $('c-name').value.trim(),
    body: $('c-body').value,
    recipients: $('c-recipients').value,
    recipientRows: recipientRows,
    countryCode: $('c-country').value.trim() || '+91',
    start: true,
  };
  const from = $('c-from').value;
  if (from) payload.from = from;
  const interval = parseInt($('c-interval').value, 10);
  if (Number.isFinite(interval)) payload.intervalSeconds = interval;
  const winStart = parseInt($('c-window-start').value, 10);
  const winEnd = parseInt($('c-window-end').value, 10);
  if (Number.isFinite(winStart)) payload.windowStartHour = winStart;
  if (Number.isFinite(winEnd)) payload.windowEndHour = winEnd;

  // The whole list travels as one JSON body, and the server caps that (BODY_LIMIT,
  // 1 MB by default). Say which knob to turn, rather than letting the browser
  // report a bare 413 that names nothing.
  const encoded = JSON.stringify(payload);
  if (encoded.length > 950000) {
    fail(
      'This list is too big to send in one request (' +
        Math.round(encoded.length / 1024) +
        ' KB). Map fewer columns, split the file, or raise BODY_LIMIT on the server.',
    );
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const res = await api('/campaigns', { method: 'POST', body: encoded });
    const meta = res.meta || {};
    const bits = ['Started — ' + meta.accepted + ' recipient(s) queued.'];
    if (meta.variables && meta.variables.length) bits.push('Merging ' + braced(meta.variables) + '.');
    if (meta.invalidCount) bits.push(meta.invalidCount + ' skipped as invalid.');
    if (meta.duplicates) bits.push(meta.duplicates + ' duplicate(s) removed.');
    if (meta.incomplete) bits.push(meta.incomplete + ' row(s) missing a value will be failed, not sent.');
    out.className = 'result ok';
    out.textContent = bits.join(' ');
    out.classList.remove('hidden');
    $('c-name').value = '';
    $('c-body').value = '';
    $('c-recipients').value = '';
    sheet = null;
    renderSheet();
    renderVarChips();
    updatePreview();
    setFileNote('', '');
    loadCampaigns();
  } catch (err) {
    fail(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create & start sending';
  }
});

async function loadCampaigns() {
  try {
    const { data } = await api('/campaigns?limit=50');
    // Enrich any expanded card with its live recipient detail.
    await Promise.all(
      data.map(async (c) => {
        if (!expandedCampaigns.has(c.id)) return;
        try {
          const detail = await api('/campaigns/' + c.id);
          c.recipients = detail.data.recipients;
        } catch {
          /* leave it without recipients; the card just shows no list */
        }
      }),
    );
    renderCampaigns(data);
  } catch (err) {
    if (err.status === 401) logout();
  }
}

function renderCampaigns(campaigns) {
  const list = $('campaigns-list');
  list.textContent = '';

  if (!campaigns.length) {
    list.appendChild(el('div', { class: 'empty', text: 'No campaigns yet. Create one above.' }));
    return;
  }

  for (const c of campaigns) list.appendChild(renderCampaignCard(c));
}

function statChip(label, value) {
  return el('span', {}, [document.createTextNode(label + ': '), el('strong', { text: value })]);
}

/** Hour number -> "HH:00" for the sending-window display. */
function pad2(hour) {
  return String(hour).padStart(2, '0') + ':00';
}

function actionBtn(label, cls, handler) {
  // type="button" is not optional. A <button> defaults to type="submit", and these
  // sit inside the campaign form - without it, "Insert" or "Next row" would submit
  // the form and start sending to the whole list.
  const b = el('button', { class: 'btn ' + cls, text: label, attrs: { type: 'button' } });
  b.addEventListener('click', handler);
  return b;
}

function renderCampaignCard(c) {
  const card = el('div', { class: 'camp' });

  card.appendChild(
    el('div', { class: 'camp-top' }, [
      el('span', { class: 'camp-name', text: c.name }),
      el('span', { class: 'badge b-' + c.status, text: c.status }),
    ]),
  );

  card.appendChild(el('div', { class: 'camp-sub', text: '“' + c.body + '”' }));

  // Progress: green for sent, red for failed, the remainder empty (pending).
  const total = c.total || 1;
  const sentSeg = el('span', { class: 'seg-sent' });
  sentSeg.style.width = Math.round((c.sentCount / total) * 100) + '%';
  const failSeg = el('span', { class: 'seg-failed' });
  failSeg.style.width = Math.round((c.failedCount / total) * 100) + '%';
  card.appendChild(el('div', { class: 'camp-progress' }, [sentSeg, failSeg]));

  card.appendChild(
    el('div', { class: 'camp-stats' }, [
      statChip('Sent', c.sentCount + ' / ' + c.total),
      statChip('Pending', String(c.pendingCount)),
      c.failedCount ? statChip('Failed', String(c.failedCount)) : null,
      statChip('From', c.from || 'auto'),
      statChip('Every', c.intervalSeconds + 's'),
      statChip('Hours', pad2(c.windowStartHour) + '–' + pad2(c.windowEndHour)),
    ]),
  );

  if (c.status === 'PAUSED' && c.pausedReason) {
    // A SYSTEM pause is the runner waiting out a blocker that clears by itself -
    // a phone reconnecting, or midnight resetting the daily caps. Say so, or the
    // card looks like a dead stop and gets a Resume click it does not need.
    var waiting = c.pausedBy === 'SYSTEM';
    card.appendChild(
      el('div', { class: 'camp-reason', text:
        (waiting ? '⏳ ' : '⏸ ') + c.pausedReason +
        (waiting ? ' It restarts on its own — no action needed.' : '') }),
    );
  }

  // Running, but the server clock is outside the sending window: it's idling until
  // business hours reopen. Shown so "0 sent, still RUNNING" isn't a mystery.
  if (c.status === 'RUNNING' && c.withinWindow === false) {
    card.appendChild(
      el('div', { class: 'camp-reason', text:
        '⏰ Outside sending hours (' + pad2(c.windowStartHour) + '–' + pad2(c.windowEndHour) +
        ', server time) — waiting to resume.' }),
    );
  }

  const actions = el('div', { class: 'camp-actions' });
  if (c.status === 'RUNNING') {
    actions.appendChild(actionBtn('Pause', 'btn-ghost', () => campaignAction(c.id, 'pause')));
  }
  if (c.status === 'PAUSED' || c.status === 'DRAFT') {
    actions.appendChild(actionBtn('Resume', 'btn-primary', () => campaignAction(c.id, 'start')));
  }
  if (c.status !== 'COMPLETED' && c.status !== 'CANCELLED') {
    actions.appendChild(actionBtn('Cancel', 'btn-danger', () => cancelCampaign(c.id, c.name)));
  }
  actions.appendChild(
    actionBtn(expandedCampaigns.has(c.id) ? 'Hide numbers' : 'View numbers', 'btn-ghost', () => toggleCampaign(c.id)),
  );
  card.appendChild(actions);

  if (expandedCampaigns.has(c.id) && c.recipients) {
    const box = el('div', { class: 'camp-recipients' });
    for (const r of c.recipients) {
      // The merged values, so a wrong figure can be traced to the row it came from
      // without opening the spreadsheet again. `name` is already in the label.
      const vars = r.vars || {};
      const merged = Object.keys(vars)
        .filter((k) => k !== 'name')
        .map((k) => k + '=' + vars[k])
        .join(' · ');

      box.appendChild(
        el('div', { class: 'rcpt' }, [
          el('span', {}, [
            el('span', { text: r.name ? r.name + ' · ' + r.to : r.to }),
            merged ? el('span', { class: 'rcpt-vars', text: merged }) : null,
          ]),
          el('span', {
            class: 'badge b-' + r.status,
            text: r.status + (r.error ? ' · ' + r.error : ''),
          }),
        ]),
      );
    }
    card.appendChild(box);
  }

  return card;
}

function toggleCampaign(id) {
  if (expandedCampaigns.has(id)) expandedCampaigns.delete(id);
  else expandedCampaigns.add(id);
  loadCampaigns();
}

async function campaignAction(id, action) {
  try {
    await api('/campaigns/' + id + '/' + action, { method: 'POST' });
    loadCampaigns();
  } catch (err) {
    alert(err.message);
  }
}

function cancelCampaign(id, name) {
  if (!confirm('Cancel “' + name + '”? Numbers not yet sent will be stopped.')) return;
  campaignAction(id, 'cancel');
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
async function loadKeys() {
  try {
    const { data } = await api('/auth/api-keys');
    renderKeys(data);
  } catch (err) {
    if (err.status === 401) logout();
  }
}

function renderKeys(keys) {
  const body = $('keys-body');
  body.textContent = '';

  if (!keys.length) {
    body.appendChild(el('tr', {}, [el('td', { class: 'empty', attrs: { colspan: '5' }, text: 'No API keys yet.' })]));
    return;
  }

  for (const k of keys) {
    const revokeBtn = el('button', { class: 'btn btn-danger', text: 'Revoke' });
    revokeBtn.addEventListener('click', () => revokeKey(k.id, k.name));

    body.appendChild(
      el('tr', {}, [
        el('td', { text: k.name }),
        el('td', { text: k.keyPrefix }),
        el('td', { text: (k.scopes || []).join(', ') }),
        el('td', { text: k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never' }),
        el('td', {}, [revokeBtn]),
      ]),
    );
  }
}

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const scopes = Array.from(document.querySelectorAll('.scopes input:checked')).map((c) => c.value);
  if (!scopes.length) {
    alert('Pick at least one scope.');
    return;
  }

  const btn = $('key-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const { data } = await api('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: $('key-name').value.trim(), scopes }),
    });
    $('key-plaintext').textContent = data.plaintext;
    $('key-created').classList.remove('hidden');
    $('key-name').value = '';
    loadKeys();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create key';
  }
});

async function revokeKey(id, name) {
  if (!confirm('Revoke "' + name + '"? Anything using it stops working immediately.')) return;
  try {
    await api('/auth/api-keys/' + id, { method: 'DELETE' });
    loadKeys();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// Account — change your own password
//
// The endpoint (POST /auth/change-password) acts on the *authenticated* user and
// takes no email, so this form can only ever change the password of whoever is
// signed in. That is deliberate: an admin-changes-anyone's-password screen is a
// different, more dangerous feature, and the API does not expose one.
//
// The server revokes every refresh token on success - including this tab's - so
// the only honest ending is to sign out and come back in with the new password.
// ---------------------------------------------------------------------------
function fillAccount() {
  $('pwd-email').value = currentUser ? currentUser.email : '';
  $('pwd-result').classList.add('hidden');
}

$('pwd-show').addEventListener('change', (e) => {
  const type = e.target.checked ? 'text' : 'password';
  for (const id of ['pwd-current', 'pwd-new', 'pwd-confirm']) $(id).type = type;
});

$('pwd-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const box = $('pwd-result');
  const btn = $('pwd-btn');
  const currentPassword = $('pwd-current').value;
  const newPassword = $('pwd-new').value;

  const show = (text, ok) => {
    box.textContent = text;
    box.classList.remove('hidden', 'ok', 'bad');
    box.classList.add(ok ? 'ok' : 'bad');
  };

  // Checked here as well as by the browser's minlength, because a mismatch or a
  // too-short password should not cost a round trip - and the confirm field is
  // ours alone: the API never sees it.
  if (newPassword !== $('pwd-confirm').value) {
    show('The two new passwords do not match.', false);
    return;
  }
  if (newPassword.length < 10) {
    show('The new password must be at least 10 characters.', false);
    return;
  }
  if (newPassword === currentPassword) {
    show('The new password must be different from the current one.', false);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Changing…';

  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    for (const id of ['pwd-current', 'pwd-new', 'pwd-confirm']) $(id).value = '';
    show('Password changed. Signing you out — sign in again with the new password.', true);

    // Every session is dead server-side; holding on to the tokens would just mean
    // a confusing 401 on the next click. Give the message a moment to be read.
    const email = currentUser ? currentUser.email : '';
    setTimeout(() => {
      logout();
      $('login-email').value = email;
      $('login-password').value = '';
      $('login-password').focus();
    }, 2000);
  } catch (err) {
    show(err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Change password';
  }
});

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------
function shortTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function timeAgo(iso) {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return secs + 's ago';
  if (secs < 3600) return Math.round(secs / 60) + 'm ago';
  if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
  return Math.round(secs / 86400) + 'd ago';
}

// ---------------------------------------------------------------------------
// Boot: if we already hold a token, try to resume the session.
// ---------------------------------------------------------------------------
(async function boot() {
  if (!localStorage.getItem(ACCESS)) return;
  try {
    const { data } = await api('/auth/me');
    enterApp(data);
  } catch {
    logout();
  }
})();
