/* Control Tower — element helpers, settings, shared state, focus handling.
   Part of a set loaded in order by index.html; they share one top-level scope. */

/* Control Tower - front end. Keyed rendering so live updates never eat what you're typing. */

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const tpl = $('#card-tpl');
const groupTpl = $('#group-tpl');

const LABEL = {
  working: 'working',
  'waiting-for-you': 'waiting for you',
  blocked: 'needs you',
  long: 'still running',
  done: 'done',
  idle: 'idle',
  here: 'in this page',
  ended: 'ended',
};

// A chat you held in this page has no process but is very much open, so Live counts it too.
const onDeck = (s) => s.alive || s.status === 'here';

/* Your settings live on the server and are injected into the page, so a second browser - your
   phone especially - sees the same sections, the same collapsed groups, the same theme.
   localStorage stays as a fallback for whatever the server has never been told about. */
const serverPrefs = window.FLEET_PREFS && typeof window.FLEET_PREFS === 'object' ? window.FLEET_PREFS : {};
let prefPatch = {};
let prefTimer = null;

const store = {
  get(k, d) {
    if (Object.prototype.hasOwnProperty.call(serverPrefs, k)) return serverPrefs[k];
    try { const v = localStorage.getItem('fleet.' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    serverPrefs[k] = v;
    try { localStorage.setItem('fleet.' + k, JSON.stringify(v)); } catch {}
    // Coalesced: dragging a slider or typing should not be one request per keystroke.
    prefPatch[k] = v;
    clearTimeout(prefTimer);
    prefTimer = setTimeout(() => {
      const patch = prefPatch;
      prefPatch = {};
      post('/api/prefs', { patch }).catch(() => { /* the local copy still holds */ });
    }, 400);
  },
};

let sessions = [];
// { claude: {label, kind, configured, canResumeInTerminal, hasFolder, hasStance, models, efforts}, ... }
let providers = { claude: { label: 'Claude Code', kind: 'cli', configured: true, canResumeInTerminal: true, hasFolder: true, hasStance: true, models: null, efforts: null } };
const providerOf = (s) => providers[s.provider] || providers.claude;
const assistantLabel = (providerId) => (providers[providerId]?.label || 'Claude').toLowerCase();
let filter = store.get('filter', 'live');
let groupBy = store.get('groupby', 'none');
let view = store.get('view', 'sessions');
let collapsed = store.get('collapsed', {});
let sectionList = store.get('sections', []);     // [{ id, name, query, filter, groupBy, pins: [] }]
let sectionId = store.get('section', '');
let query = '';
let dismissed = store.get('dismissed', {});   // id -> lastActivity it was dismissed at
let expanded = store.get('expanded', {});     // id -> true, cards showing their recent messages
let notify = store.get('notify', false);
let prevStatus = new Map();
let firstPaint = true;
let selected = null;
let upFirstId = null;
const cards = new Map();                       // id -> element
const groups = new Map();                      // group key -> { section, body, name, count, hot }

/* ------------------------------------------------------------------ utils */

/* Focus handling for the two dialogs: Tab used to walk straight out of an open panel into the
   board behind it, and closing left focus nowhere. Both now behave. */
let lastFocus = null;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const dialog = [$('#editor'), $('#key-modal'), $('#drawer')].find((d) => d && !d.hidden);
  if (!dialog || !dialog.contains(document.activeElement)) return;
  const stops = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
document.addEventListener('keydown', trapFocus, true);

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '') || null;
const clipText = (s, n) => (s.length > n ? s.slice(0, n).trim() + '…' : s);
const kilo = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
const escape = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const idKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function toast(text, detail, kind) {
  const el = h('div', 'toast' + (kind ? ' ' + kind : ''), text);
  if (detail) el.append(h('small', '', detail));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

const send = (path, body) => fetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-fleet-token': window.FLEET_TOKEN },
  body: JSON.stringify(body),
});

/* The write token belongs to one server run. Restart the server under an open tab and every write
   used to fail with "bad token" until you reloaded; now the page notices, picks up the current
   token and tries the same request again. */
async function post(path, body) {
  let res = await send(path, body);
  let data = await res.json().catch(() => ({}));

  if (res.status === 403 && data.error === 'bad token') {
    const fresh = await fetch('/api/token').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (fresh?.token && fresh.token !== window.FLEET_TOKEN) {
      window.FLEET_TOKEN = fresh.token;
      res = await send(path, body);
      data = await res.json().catch(() => ({}));
    } else {
      throw new Error('this page lost touch with the server — reload it');
    }
  }

  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast('Copied', label || text, 'good'); }
  catch { toast('Copy blocked by the browser', label || text, 'bad'); }
}
