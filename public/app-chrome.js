/* Rals Cockpit — top-bar wiring, keyboard, the live feed, and boot. Loaded after app-drawer.js. */

/* ------------------------------------------------------------------ chrome */

function setFilter(next) {
  filter = next; store.set('filter', filter);
  for (const b of document.querySelectorAll('#filters button')) b.classList.toggle('on', b.dataset.filter === filter);
}

for (const b of document.querySelectorAll('#filters button')) {
  b.classList.toggle('on', b.dataset.filter === filter);
  b.addEventListener('click', () => { setFilter(b.dataset.filter); render(); });
}

for (const b of document.querySelectorAll('#views button')) {
  b.addEventListener('click', () => setView(b.dataset.view));
}

$('#groupby').value = groupBy;
$('#groupby').addEventListener('change', (e) => {
  groupBy = e.target.value; store.set('groupby', groupBy);
  resetGroups();
  render();
});

$('#search').addEventListener('input', (e) => {
  query = e.target.value;
  if (view === 'sessions') { paintSections(); render(); } else paintToolbox();
});

$('#section-add').addEventListener('click', () => newSection());

$('#undismiss').addEventListener('click', () => {
  const back = sessions.filter((s) => inSection(s, activeSection()) && isDismissed(s));
  for (const s of back) delete dismissed[s.id];
  store.set('dismissed', dismissed);
  toast(`Brought back ${back.length}`, back.map((s) => s.title).join(', '), 'good');
  render();
});

// One-click cleanup for finished sessions - reversible from the undismiss button above, so this
// is safe to point at everything in the section rather than just what's on screen for one filter.
$('#dismiss-done').addEventListener('click', () => {
  const done = sessions.filter((s) => inSection(s, activeSection()) && !isDismissed(s) && s.status === 'done');
  for (const s of done) dismissed[s.id] = s.lastActivity;
  store.set('dismissed', dismissed);
  toast(`Dismissed ${done.length}`, done.map((s) => s.title).join(', '), 'good');
  render();
});

/* Alerts, theme and phone pairing used to be three more icons in an already-full top bar. They
   are one "more" menu now: the top bar is where you are and what you are doing, this is settings. */

async function toggleAlerts() {
  if (!notify) {
    if (!('Notification' in window)) return toast('This browser has no notification support', '', 'bad');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications blocked', 'Allow them in the site settings to get alerts.', 'bad');
    notify = true;
    toast('Desktop alerts on', 'You will be pinged when a session needs you, and when an answer lands.', 'good');
  } else {
    notify = false;
    toast('Desktop alerts off');
  }
  store.set('notify', notify);
}

function setTheme(next) {
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
}

/* Phone access is listed whether it is on or off. Off is the case that actually needs telling -
   there is nothing in the interface to hint the feature exists otherwise. Both states go to the same
   page: with the port open it draws a code to point a camera at, and without it, it says so and says
   what to run instead. Better than a toast holding an address nobody wants to type into a phone. */
function phoneRow() {
  const on = !!window.FLEET_PHONE?.urls?.length;
  return {
    label: on ? 'Phone access — scan a code' : 'Phone access — set it up',
    tick: on,
    pick: () => { closePopover(); window.open('/pair', '_blank'); },
  };
}

// One row per api-key provider in the registry - today that's just OpenAI, but nothing here
// assumes there's only ever one.
function providerKeyRows() {
  return Object.entries(providers)
    .filter(([, p]) => p.kind === 'api-key')
    .map(([id, p]) => ({
      label: p.configured ? `${p.label} API key — change it` : `${p.label} API key — set it up`,
      tick: p.configured,
      pick: () => { closePopover(); openKeyModal(id); },
    }));
}

// The only network call in this app besides an OpenAI-provider turn, and it only ever happens
// here - on a click, never on a timer or on boot.
async function checkForUpdates() {
  closePopover();
  let data;
  try {
    data = await fetch('/api/update-check').then((r) => r.json());
  } catch (e) {
    toast('Could not check for updates', e.message, 'bad');
    return;
  }
  if (data.error) { toast('Could not check for updates', data.error, 'bad'); return; }
  if (data.upToDate) { toast('You’re up to date', `v${data.current}`, 'good'); return; }
  const el = h('div', 'toast good', `v${data.latest} is out`);
  el.append(h('small', '', `you're on v${data.current}${data.url ? ' — click to see what changed' : ''}`));
  if (data.url) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { window.open(data.url, '_blank'); el.remove(); });
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 15000);
}

$('#btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  if (popover) { closePopover(); return; }
  const dark = document.documentElement.dataset.theme === 'dark';
  openMenu($('#btn-more'), {
    head: 'settings',
    rows: [
      { label: 'Desktop alerts', tick: notify, pick: () => { closePopover(); toggleAlerts(); } },
      { label: dark ? 'Switch to light' : 'Switch to dark', pick: () => { closePopover(); setTheme(dark ? 'light' : 'dark'); } },
      { label: 'Check for updates', pick: checkForUpdates },
      phoneRow(),
      ...providerKeyRows(),
    ],
    // No how-to entry here: it already has its own labelled button in the top bar.
    note: window.FLEET_PHONE?.urls?.length
      ? `paired devices reach this at ${window.FLEET_PHONE.urls[0].replace(/\?k=.*/, '')} — same Wi-Fi only`
      : 'phone access is off for this run',
  });
});

const theme = store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = theme;

function select(id) {
  selected = id;
  for (const [cid, el] of cards) el.classList.toggle('sel', cid === id);
  cards.get(id)?.scrollIntoView({ block: 'nearest' });
}

/* Every figure on the Usage view minimises, and remembers that it is minimised. */
const figs = [...document.querySelectorAll('.figure[id]')];
const figKey = (fig) => 'fig:' + fig.id;

function paintFig(fig) {
  const shut = !!collapsed[figKey(fig)];
  fig.classList.toggle('shut', shut);
  const btn = fig.querySelector('.fig-toggle');
  btn.title = shut ? 'Expand' : 'Minimise';
  btn.setAttribute('aria-expanded', String(!shut));
}

for (const fig of figs) {
  fig.querySelector('.fig-toggle').addEventListener('click', () => {
    collapsed[figKey(fig)] = !collapsed[figKey(fig)];
    store.set('collapsed', collapsed);
    paintFig(fig);
    paintFigAll();
  });
  paintFig(fig);
}

function paintFigAll() {
  const allShut = figs.every((f) => collapsed[figKey(f)]);
  $('#fig-all').textContent = allShut ? 'expand all' : 'minimise all';
}

$('#fig-all').addEventListener('click', () => {
  const shut = !figs.every((f) => collapsed[figKey(f)]);
  for (const f of figs) { collapsed[figKey(f)] = shut; paintFig(f); }
  store.set('collapsed', collapsed);
  paintFigAll();
});
paintFigAll();

for (const b of document.querySelectorAll('#usage-range button')) {
  b.classList.toggle('on', Number(b.dataset.days) === usageDays);
  b.addEventListener('click', () => {
    usageDays = Number(b.dataset.days);
    store.set('usagedays', usageDays);
    for (const o of document.querySelectorAll('#usage-range button')) o.classList.toggle('on', o === b);
    paintUsage();
  });
}
$('#usage-table-toggle').addEventListener('click', () => { usageAsTable = !usageAsTable; paintUsage(); });
$('#usage-pill').addEventListener('click', () => setView('usage'));

const GROUPINGS = ['none', 'project', 'status', 'branch', 'section', 'origin'];
const VIEWS = ['sessions', 'mcp', 'tools', 'rules', 'search', 'usage'];

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') {
    if (!$('#drawer').hidden) closeDrawer();
    else if (typing) document.activeElement.blur();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === '?') { e.preventDefault(); window.open('/help.html', '_blank'); return; }
  if (e.key >= '1' && e.key <= '6') { e.preventDefault(); setView(VIEWS[Number(e.key) - 1]); return; }
  if (e.key === 'a') { e.preventDefault(); if (upFirstId) jumpTo(upFirstId); return; }
  if (e.key === 'g') {
    e.preventDefault();
    groupBy = GROUPINGS[(GROUPINGS.indexOf(groupBy) + 1) % GROUPINGS.length];
    $('#groupby').value = groupBy; store.set('groupby', groupBy);
    resetGroups();
    render();
    return;
  }
  // s / S walk the saved sections, so a keyboard-only pass over your own sections works.
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    const ids = ['', ...sectionList.map((x) => x.id)];
    const i = ids.indexOf(sectionId);
    const step = e.key === 'S' ? -1 : 1;
    applySection(ids[(i + step + ids.length) % ids.length]);
    return;
  }
  if (view !== 'sessions') return;
  const ids = visible().map((s) => s.id);
  if (!ids.length) return;
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const i = ids.indexOf(selected);
    const next = e.key === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
    select(ids[next < 0 ? 0 : next]);
  } else if (e.key === 'Enter' && selected) {
    e.preventDefault(); openDrawer(selected);
  } else if (e.key === 'e' && selected) {
    e.preventDefault(); toggleExpand(selected);
  } else if (e.key === 'r' && selected) {
    e.preventDefault(); cards.get(selected)?.querySelector('textarea')?.focus();
  } else if (e.key === 'i' && selected) {
    e.preventDefault(); toggleIdle(selected);
  }
});

/* ------------------------------------------------------------------ live feed */

let retryIn = 1000;

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    $('#conn-dot').classList.remove('off');
    retryIn = 1000;                        // a good connection resets the backoff
    try { apply(JSON.parse(e.data)); } catch {}
  });
  es.addEventListener('open', () => { $('#conn-dot').classList.remove('off'); retryIn = 1000; });
  es.addEventListener('error', () => {
    $('#conn-dot').classList.add('off');
    $('#conn-dot').title = `reconnecting in ${Math.round(retryIn / 1000)}s`;
    es.close();
    // Backed off: a server that is down stops being hit twice a second for ever.
    setTimeout(connect, retryIn);
    retryIn = Math.min(30000, Math.round(retryIn * 1.8));
  });
}

migrateSections();
paintSections();
setView(view);
connect();
loadToolbox();
loadUsage();
loadProviders();
setInterval(() => {
  for (const [id, el] of cards) el.querySelector('.ago').textContent = ago(cur(id).lastActivity);
}, 1000);
setInterval(loadToolbox, 60_000);
setInterval(loadUsage, 90_000);
