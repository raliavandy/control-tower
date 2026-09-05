/* Control Tower — popover menus, model and effort. Loaded after app-board.js. */

/* -------------------------------------------------- little menus

   One popover, hung off <body> so a board re-render can't tear it out from under the cursor. */

let popover = null;
const closePopover = () => { popover?.remove(); popover = null; };

document.addEventListener('click', (e) => {
  if (popover && !popover.contains(e.target) && !e.target.closest('.opens-menu')) closePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (popover) { closePopover(); return; }
  if (!$('#key-modal').hidden) { closeKeyModal(); return; }
  if (!$('#editor').hidden) closeEditor();
}, true);

// rows: [{ label, tick, count, pick }] · footer: { label, pick }
function openMenu(anchor, { head, note, rows, footer, empty }) {
  closePopover();
  const menu = h('div', 'popover');
  if (head) menu.append(h('p', 'popover-head', head));
  if (!rows.length && empty) menu.append(h('p', 'popover-empty', empty));
  for (const r of rows) {
    const row = h('button', 'popover-row' + (r.tick ? ' on' : ''));
    row.append(h('span', 'tick', r.tick ? '✓' : ''));
    row.append(h('span', 'popover-name', r.label));
    if (r.count !== undefined) row.append(h('span', 'count', String(r.count)));
    row.addEventListener('click', (e) => { e.stopPropagation(); r.pick(); });
    menu.append(row);
  }
  if (footer) {
    const f = h('button', 'popover-row add', footer.label);
    f.addEventListener('click', (e) => { e.stopPropagation(); footer.pick(); });
    menu.append(f);
  }
  if (note) menu.append(h('p', 'popover-note', note));

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, box.left)) + 'px';
  const below = box.bottom + 6;
  menu.style.top = (below + menu.offsetHeight > window.innerHeight - 8
    ? Math.max(8, box.top - menu.offsetHeight - 6)
    : below) + 'px';
  popover = menu;
}

function openSectionMenu(id, anchor) {
  openMenu(anchor, {
    head: 'sections for this chat',
    empty: 'You have no sections yet.',
    rows: sectionList.map((section) => ({
      label: section.name,
      tick: section.members.includes(id),
      count: section.members.length,
      pick: () => { toggleMember(section, id); openSectionMenu(id, anchor); },
    })),
    footer: { label: '+ new section…', pick: () => { closePopover(); newSection(id); } },
  });
}

/* -------------------------------------------------- model and effort

   Claude Code has no way to retune a session that is already running, so picking a value here
   does what the reply box does: opens a new window resuming the same history, with
   `--model` / `--effort` set. The window already running it keeps whatever it started with. */

const MODELS = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'fable', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const REOPEN_NOTE = 'Opens a new window resuming this chat. Any window already running it is left alone.';

async function relaunch(s, opts) {
  closePopover();
  try {
    const r = await post('/api/reply', { id: s.id, cwd: s.cwd, ...opts });
    const what = [r.model && 'model ' + r.model, r.effort && 'effort ' + r.effort].filter(Boolean).join(' · ');
    toast('Reopened in ' + r.terminal, what || s.title, 'good');
  } catch (e) {
    toast('Could not reopen', e.message, 'bad');
  }
}

// claude-opus-5[1m] -> opus[1m], so the alias list can show which one you are on.
function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => m.includes(f));
  return family ? family + (m.includes('1m') ? '[1m]' : '') : null;
}

function openModelMenu(s, anchor) {
  const now = modelFamily(s.model);
  openMenu(anchor, {
    head: 'reopen this chat on',
    note: REOPEN_NOTE,
    rows: MODELS.map((m) => ({
      label: m,
      tick: now === m,
      pick: () => relaunch(s, { model: m }),
    })),
    footer: {
      label: 'another model…',
      pick: () => {
        closePopover();
        const m = (prompt('Model alias or full name', shortModel(s.model) || 'opus') || '').trim();
        if (m) relaunch(s, { model: m });
      },
    },
  });
}

function openEffortMenu(s, anchor) {
  const now = s.effort || 'medium';
  openMenu(anchor, {
    head: 'reopen this chat at effort',
    note: REOPEN_NOTE,
    rows: EFFORTS.map((e) => ({ label: e, tick: e === now, pick: () => relaunch(s, { effort: e }) })),
  });
}

function groupKeyOf(s) {
  if (groupBy === 'project') return s.project || 'unknown';
  if (groupBy === 'status') return LABEL[s.status] || s.status;
  if (groupBy === 'branch') return s.gitBranch || '(no branch)';
  if (groupBy === 'origin') return s.origin?.label || 'unknown';
  if (groupBy === 'section') {
    // Your own sections are the one grouping you defined by hand, so it belongs in this list.
    const mine = sectionList.filter((x) => x.members.includes(s.id)).map((x) => x.name);
    return mine.length ? mine.join(' + ') : 'no section';
  }
  return '';
}

function ensureGroup(key) {
  let g = groups.get(key);
  if (g) return g;
  const section = groupTpl.content.firstElementChild.cloneNode(true);
  g = {
    section,
    head: section.querySelector('.group-head'),
    body: section.querySelector('.group-body'),
    name: section.querySelector('.group-name'),
    count: section.querySelector('.group-count'),
    hot: section.querySelector('.group-hot'),
  };
  g.name.textContent = key;
  g.head.hidden = key === '';
  g.head.addEventListener('click', () => {
    const k = groupBy + ':' + key;
    collapsed[k] = !collapsed[k];
    store.set('collapsed', collapsed);
    render();
  });
  groups.set(key, g);
  board.append(section);
  return g;
}

function render() {
  const list = visible();

  const buckets = new Map();
  for (const s of list) {
    const k = groupKeyOf(s);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }

  const keep = new Set(list.map((s) => s.id));
  for (const [id, el] of cards) if (!keep.has(id)) { el.remove(); cards.delete(id); }
  for (const [key, g] of groups) if (!buckets.has(key)) { g.section.remove(); groups.delete(key); }

  // Reordering moves DOM nodes, which would blur a focused reply box - so hold off while typing.
  const typing = document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.closest('.card');

  for (const [key, items] of buckets) {
    const g = ensureGroup(key);
    const shut = !!collapsed[groupBy + ':' + key];
    g.section.classList.toggle('shut', shut);
    g.count.textContent = items.length;
    const needy = items.filter((s) => s.needsYou).length;
    g.hot.hidden = !needy;
    g.hot.textContent = needy + ' need you';

    for (const s of items) {
      let el = cards.get(s.id);
      if (!el) { el = makeCard(s); cards.set(s.id, el); g.body.append(el); }
      paintCard(el, s);
      el.classList.toggle('sel', s.id === selected);
    }
  }

  if (!typing) {
    for (const [key, items] of buckets) {
      const g = groups.get(key);
      board.append(g.section);
      for (const s of items) g.body.append(cards.get(s.id));
    }
  }

  const section = activeSection();
  paintHeader();   // the counts describe this board, so they are repainted with it
  $('#empty').hidden = list.length > 0;
  $('#empty').textContent = query
    ? `Nothing matches “${query}”.`
    : section ? `“${section.name}” is empty. Switch to everything, then use the sections link on a card to add it here.`
    // A genuinely fresh install: nothing under ~/.claude at all, regardless of which filter tab
    // happens to be active. A new user lands on the default "Live" tab, where this would
    // otherwise be masked by "No live sessions" - which reads like a stall, not an empty install.
    : !sessions.length ? 'Nothing here yet. Click “+ New chat” above to start one, or open a terminal and run claude.'
    : filter === 'needs' ? 'Nobody is waiting on you. ✨'
    : filter === 'live' ? 'No Claude Code sessions are running right now.'
    : 'No sessions found under ~/.claude.';
}

function resetGroups() {
  for (const [, g] of groups) g.section.remove();
  groups.clear();
}

const isDismissed = (s) => dismissed[s.id] !== undefined && dismissed[s.id] >= s.lastActivity;

/* Counts describe what the board is actually showing, so a number can never contradict the
   screen. They honour the section and dismissals - the two persistent filters - but not the
   search box, which would make them twitch on every keystroke. */
function onBoard() {
  const section = activeSection();
  return sessions.filter((s) => inSection(s, section) && !isDismissed(s));
}

let lastStats = {};

function paintHeader() {
  const st = lastStats;
  const shown = onBoard();
  const live = shown.filter((s) => s.alive);
  const here = shown.filter((s) => s.status === 'here');
  const needs = live.filter((s) => s.needsYou);
  const working = live.filter((s) => s.status === 'working').length;
  const blocked = needs.filter((s) => s.status === 'blocked').length;
  const hidden = sessions.filter((s) => inSection(s, activeSection()) && isDismissed(s));

  $('#c-needs').textContent = needs.length;
  $('#c-live').textContent = live.length + here.length;
  $('#c-all').textContent = shown.length;
  $('#c-sessions').textContent = live.length + here.length;

  const head = $('#headline');
  const chats = here.length ? ` · <b>${here.length}</b> chat${here.length > 1 ? 's' : ''} here` : '';
  const aside = hidden.length ? ` · <b>${hidden.length} dismissed</b>` : '';
  if (!live.length && !here.length) head.innerHTML = `<b>no live sessions</b> · ${shown.length} in history${aside}`;
  else if (!live.length) head.innerHTML = `<b>${here.length}</b> chat${here.length > 1 ? 's' : ''} in this page${aside}`;
  else if (needs.length) head.innerHTML = `<b class="hot">${needs.length} of ${live.length}</b> sessions need you · ${working} working${chats}${aside}`;
  else head.innerHTML = `<b>${live.length}</b> live · all busy, nothing waiting on you${chats}${aside}`;
  head.title = head.textContent;   // it truncates on narrow windows, so keep the full text reachable

  // It lives in .sessions-only, but painting the header must not undo setView's hiding.
  const undo = $('#undismiss');
  undo.hidden = !hidden.length || view !== 'sessions';
  undo.textContent = `bring back ${hidden.length} dismissed`;
  undo.title = hidden.map((s) => s.title).join('\n');

  const doneNow = shown.filter((s) => s.status === 'done');
  const dismissDone = $('#dismiss-done');
  dismissDone.hidden = !doneNow.length || view !== 'sessions';
  dismissDone.textContent = `dismiss ${doneNow.length} done`;
  dismissDone.title = doneNow.map((s) => s.title).join('\n');

  document.title = needs.length ? `(${needs.length}) Control Tower` : 'Control Tower';
  PX.favicon(blocked ? 'blocked' : needs.length ? 'waiting-for-you' : live.length ? 'working' : 'ended');
  // No banner for it - the queue only shows as a badge on the card, plus the `a` shortcut.
  upFirstId = st.firstUp && shown.some((s) => s.id === st.firstUp) ? st.firstUp : null;
}

function alertOn(list) {
  for (const s of list) {
    const was = prevStatus.get(s.id);
    prevStatus.set(s.id, s.status);
    if (firstPaint || !s.alive) continue;
    if (was === s.status) continue;
    if (s.status !== 'blocked' && s.status !== 'waiting-for-you') continue;
    if (notify && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(s.status === 'blocked' ? 'Claude needs you' : 'Claude is waiting', {
        body: `${s.title}\n${s.project}${s.gitBranch ? ' · ' + s.gitBranch : ''}`,
        tag: s.id, silent: false,
      });
      n.onclick = () => { window.focus(); openDrawer(s.id); n.close(); };
    }
  }
  for (const id of [...prevStatus.keys()]) if (!sessions.some((s) => s.id === id)) prevStatus.delete(id);
  firstPaint = false;
}

function apply(state) {
  sessions = state.sessions || [];
  lastStats = state.stats || {};
  paintSections();
  render();
  if (view !== 'sessions') paintToolbox();   // session chips in the panels track live usage
  alertOn(sessions);
}
