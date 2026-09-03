/* Rals Cockpit — the usage view. Loaded after app-inventory.js. */

/* -------------------------------------------------- usage

   Counted from the transcripts, because ~/.claude/stats-cache.json only refreshes when the CLI
   recomputes it. One measure (tokens) over time, so: one hue, no legend, tooltips on the bars,
   and a table view behind a toggle. */

let usageData = null;
let usageDays = store.get('usagedays', 30);
let usageAsTable = false;
let usageLoading = false;

const tokens = (n) => {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
};
const dayLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return when(new Date(y, m - 1, d).getTime());
};

async function loadUsage() {
  if (usageLoading) return;
  usageLoading = true;
  try {
    const res = await fetch('/api/usage');
    usageData = await res.json();
  } catch (e) {
    toast('Could not read usage', e.message, 'bad');
  } finally {
    usageLoading = false;
  }
  paintUsagePill();
  if (view === 'usage') paintUsage();
}

const blankDay = (date) => ({ date, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* Calendar days, not "the last N rows we happen to have" - and quiet days are filled with zeros
   so the gaps in the chart are real gaps rather than days squeezed together. */
function windowOf(days) {
  if (!usageData?.days.length) return [];
  const known = new Map(usageData.days.map((d) => [d.date, d]));
  const end = new Date();
  const start = new Date();
  if (days) start.setDate(end.getDate() - (days - 1));
  else {
    const [y, m, d] = usageData.days[0].date.split('-').map(Number);
    start.setFullYear(y, m - 1, d);
  }
  const out = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const iso = isoOf(cursor);
    out.push(known.get(iso) || blankDay(iso));
  }
  return out;
}

// The sparkline doubles as the Usage tab, so it is always present - it just has nothing to draw
// until the first count lands. A fortnight's shape beats a fake "percent of limit" bar.
function paintUsagePill() {
  const pill = $('#usage-pill');
  if (!usageData) return;
  const today = usageData.days.find((d) => d.date === usageData.today);
  $('#usage-pill-num').textContent = tokens(today?.output || 0);
  const recent = usageData.days.slice(-14);
  const peak = Math.max(1, ...recent.map((d) => d.output));
  const spark = $('#usage-spark');
  spark.replaceChildren(...recent.map((d) => {
    const bar = h('i');
    bar.style.height = Math.max(9, Math.round((d.output / peak) * 100)) + '%';
    if (d.date === usageData.today) bar.className = 'now';
    bar.title = `${dayLabel(d.date)} · ${tokens(d.output)} out`;
    return bar;
  }));
}

function tile(label, span, sub) {
  const el = h('div', 'tile');
  el.append(h('span', 'tile-label', label));
  el.append(h('strong', 'tile-num', tokens(span.output)));
  el.append(h('span', 'tile-sub', sub));
  return el;
}

function sumOf(list) {
  return list.reduce((t, d) => ({
    requests: t.requests + d.requests, input: t.input + d.input, output: t.output + d.output,
    cacheRead: t.cacheRead + d.cacheRead, cacheCreate: t.cacheCreate + d.cacheCreate,
  }), { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
}

function paintChart(list) {
  const chart = $('#usage-chart');
  chart.replaceChildren();
  if (!list.length) { chart.append(h('p', 'empty', 'Nothing recorded in this window.')); return; }

  const peak = Math.max(1, ...list.map((d) => d.output));
  const peakDate = list.find((d) => d.output === peak && d.output > 0)?.date;

  // Two recessive gridlines, so a bar can be read against something.
  for (const frac of [1, 0.5]) {
    const line = h('div', 'gridline');
    line.style.bottom = `calc(${frac * 100}% * (1 - var(--axis-space)))`;
    line.append(h('span', 'gridline-label', tokens(Math.round(peak * frac))));
    chart.append(line);
  }

  const plot = h('div', 'plot');
  for (const d of list) {
    const col = h('div', 'col');
    // A day with nothing on it gets no mark at all - a minimum-height stub would read as usage.
    if (d.output > 0) {
      const bar = h('div', 'bar' + (d.date === usageData.today ? ' now' : ''));
      bar.style.height = (d.output / peak) * 100 + '%';
      col.append(bar);
    }
    // Label only what earns it: the peak and today.
    if (d.date === peakDate || d.date === usageData.today) col.append(h('span', 'bar-tag', tokens(d.output)));
    col.tabIndex = 0;
    const detail = `${dayLabel(d.date)}\n${tokens(d.output)} output · ${tokens(d.input)} input\n` +
      `${tokens(d.cacheRead)} read from cache · ${tokens(d.cacheCreate)} written\n${d.requests} requests`;
    col.title = detail;
    const show = () => showChartTip(col, d, chart);
    col.addEventListener('mouseenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('mouseleave', hideChartTip);
    col.addEventListener('blur', hideChartTip);
    plot.append(col);
  }
  chart.append(plot);

  const axis = h('div', 'axis');
  const step = Math.max(1, Math.ceil(list.length / 8));
  list.forEach((d, i) => {
    const cell = h('span', '', i % step === 0 || i === list.length - 1 ? dayLabel(d.date) : '');
    axis.append(cell);
  });
  chart.append(axis);
}

let chartTip = null;
function showChartTip(anchor, d, chart) {
  hideChartTip();
  chartTip = h('div', 'charttip');
  chartTip.append(h('b', '', dayLabel(d.date) + (d.date === usageData.today ? ' · today' : '')));
  for (const [k, v] of [['output', d.output], ['input', d.input], ['cache read', d.cacheRead], ['cache written', d.cacheCreate]]) {
    const row = h('span', 'charttip-row');
    row.append(h('span', '', k), h('b', '', tokens(v)));
    chartTip.append(row);
  }
  const row = h('span', 'charttip-row');
  row.append(h('span', '', 'requests'), h('b', '', String(d.requests)));
  chartTip.append(row);
  document.body.append(chartTip);
  const box = anchor.getBoundingClientRect();
  chartTip.style.left = Math.max(8, Math.min(window.innerWidth - chartTip.offsetWidth - 8, box.left + box.width / 2 - chartTip.offsetWidth / 2)) + 'px';
  // Stay inside the figure: a tall bar would otherwise push the tooltip up over the stat tiles.
  const ceiling = Math.max(8, chart ? chart.getBoundingClientRect().top : 8);
  const above = box.top - chartTip.offsetHeight - 8;
  chartTip.style.top = (above < ceiling ? box.bottom + 8 : above) + 'px';
}
function hideChartTip() { chartTip?.remove(); chartTip = null; }

function paintChartTable(list) {
  const wrap = $('#usage-chart-table');
  wrap.replaceChildren();
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const c of ['day', 'output', 'input', 'cache read', 'cache written', 'requests']) head.append(h('th', '', c));
  table.append(head);
  for (const d of [...list].reverse()) {
    const tr = document.createElement('tr');
    tr.append(h('td', '', dayLabel(d.date)));
    for (const v of [d.output, d.input, d.cacheRead, d.cacheCreate]) tr.append(h('td', 'num', tokens(v)));
    tr.append(h('td', 'num', String(d.requests)));
    table.append(tr);
  }
  wrap.append(table);
}

function paintRanks(el, rows, key) {
  el.replaceChildren();
  const peak = Math.max(1, ...rows.map((r) => r.output));
  for (const r of rows) {
    const row = h('div', 'rank-row');
    const label = h('div', 'rank-head');
    label.append(h('span', 'rank-name', r[key]));
    label.append(h('span', 'rank-num', `${tokens(r.output)} out · ${r.requests} req`));
    const track = h('div', 'rank-track');
    const fill = h('div', 'rank-fill');
    fill.style.width = (r.output / peak) * 100 + '%';
    track.append(fill);
    row.append(label, track);
    row.title = `${r[key]}\n${tokens(r.output)} output · ${tokens(r.input)} input\n${tokens(r.cacheRead)} read from cache\n${r.requests} requests`;
    el.append(row);
  }
}

function paintUsage() {
  if (!usageData) { $('#usage-note').textContent = 'counting your transcripts…'; return; }
  const all = usageData.days;
  const today = all.find((d) => d.date === usageData.today) || blankDay(usageData.today);
  const week = windowOf(7), month = windowOf(30);
  const weekSum = sumOf(week), monthSum = sumOf(month);

  // Only ever shown if a cost actually exists. On a subscription plan nothing on disk carries
  // one for Claude, and a row of $0.00 would be worse than saying so plainly. OpenAI is metered,
  // so once you've used it there is a real (if estimated) figure to add in.
  const spend = usageData.totals.cost || 0;
  const usedOpenai = usageData.projects.some((p) => p.project === 'ChatGPT');
  const costLine = spend > 0
    ? `<b>$${spend.toFixed(2)}</b> recorded all-time` +
      (usedOpenai ? ' — exact where Claude Code records it (usually nothing, on a subscription), estimated from published list pricing for ChatGPT.' : '.')
    : usedOpenai ? 'Nothing recorded yet.'
    : 'No cost is recorded on this plan — Claude Code writes zero for every request, so there is nothing to total.';

  $('#usage-note').innerHTML =
    `Counted from every transcript under <b>~/.claude/projects</b>, plus every ChatGPT chat this app has run — ` +
    `<b>${usageData.totals.requests.toLocaleString()}</b> requests across <b>${all.length}</b> active days. ` +
    `Output tokens are the headline; cache reads dwarf everything else and are shown separately. ` +
    costLine;

  $('#usage-tiles').replaceChildren(
    tile('today', today, `${today.requests} requests · ${tokens(today.cacheRead)} from cache`),
    tile('last 7 days', weekSum, `${weekSum.requests} requests · ${week.filter((d) => d.requests).length} active`),
    tile('last 30 days', monthSum, `${monthSum.requests} requests · ${month.filter((d) => d.requests).length} active`),
    tile('all time', usageData.totals, `${usageData.totals.requests.toLocaleString()} requests · ${tokens(usageData.totals.cacheRead)} from cache`),
  );

  const list = windowOf(usageDays);
  $('#usage-chart').hidden = usageAsTable;
  $('#usage-chart-table').hidden = !usageAsTable;
  $('#usage-table-toggle').textContent = usageAsTable ? 'show as chart' : 'show as table';
  if (usageAsTable) paintChartTable(list); else paintChart(list);

  paintRanks($('#usage-models'), usageData.models, 'model');
  paintRanks($('#usage-projects'), usageData.projects, 'project');

  // The API volunteers the real rate-limit window on each in-page turn, so show it once we have it.
  const rl = usageData.rateLimit;
  const rlNote = $('#usage-ratelimit');
  if (rl) {
    const resets = rl.resetsAt ? new Date(rl.resetsAt * 1000) : null;
    rlNote.hidden = false;
    rlNote.innerHTML =
      `<b>${String(rl.rateLimitType || 'rate').replace(/_/g, '-')} window:</b> ${rl.status}` +
      (resets ? ` · resets ${resets.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '') +
      (rl.overageStatus && rl.overageStatus !== 'allowed' ? ` · extra usage ${rl.overageStatus}` : '') +
      (rl.overageDisabledReason ? ` (${String(rl.overageDisabledReason).replace(/_/g, ' ')})` : '') +
      ` — straight from the API, seen on your last in-page chat.`;
  } else {
    rlNote.hidden = false;
    rlNote.innerHTML = 'Send one message from the <b>New chat</b> panel and the real rate-limit window shows up here — it only comes back on a live API turn.';
  }

  const stale = usageData.statsCache?.lastComputedDate;
  $('#usage-caveat').innerHTML =
    `<b>What this is not:</b> a token-by-token quota. The window above is what the API reports; ` +
    `the counts below are what your transcripts record. Run <b>/usage</b> inside Claude Code for ` +
    `Anthropic's own breakdown. ` +
    `Claude Code's own <b>stats-cache.json</b> is here but only recomputes when the CLI feels like it ` +
    (stale ? `(yours last did on <b>${stale}</b>), ` : '') +
    `so these figures come from the transcripts instead. ` +
    `Messages replayed into forked or resumed sessions are counted once — that skipped ` +
    `<b>${usageData.duplicatesSkipped.toLocaleString()}</b> of them here.` +
    (usedOpenai ? ` ChatGPT's cost is computed from real token counts against a published price list kept ` +
      `in this app — accurate as of when that list was last updated, not a live lookup.` : '');
}
