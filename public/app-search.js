/* Control Tower — deep search, and switching view. Loaded after app-usage.js. */

/* -------------------------------------------------- deep search

   The board's filter only ever saw each transcript's digested tail. This reads the files, so
   "which chat did I fix the tally slip in" is answerable across the whole history. */

let searching = false;

async function runSearch(q) {
  const wrap = $('#hits');
  const note = $('#search-note');
  if (!q || q.trim().length < 2) {
    wrap.replaceChildren();
    note.textContent = 'Type at least two characters.';
    return;
  }
  if (searching) return;
  searching = true;
  note.textContent = 'reading transcripts…';
  wrap.replaceChildren();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=60`);
    const r = await res.json();
    note.innerHTML = r.hits.length
      ? `<b>${r.hits.length}</b> match${r.hits.length === 1 ? '' : 'es'} in <b>${r.files}</b> chat${r.files === 1 ? '' : 's'} · ${r.scanned} transcripts read`
      : `Nothing said “${escape(q)}” in any of the ${r.scanned} transcripts.`;
    wrap.replaceChildren(...r.hits.map((hit) => {
      const row = h('article', 'hit');
      const head = h('div', 'hit-head');
      const open = h('button', 'hit-title', hit.title || hit.id.slice(0, 8));
      open.title = 'Open this conversation';
      open.addEventListener('click', () => { setView('sessions'); jumpTo(hit.id); openDrawer(hit.id); });
      head.append(open);
      head.append(h('span', 'badge muted', hit.project));
      head.append(h('span', 'badge muted', hit.role === 'user' ? 'you' : assistantLabel(hit.provider)));
      if (hit.ts) head.append(h('span', 'hit-when', new Date(hit.ts).toLocaleString()));
      row.append(head);
      const snip = h('p', 'hit-snip');
      snip.append(document.createTextNode('…' + hit.before));
      snip.append(h('mark', '', hit.match));
      snip.append(document.createTextNode(hit.after + '…'));
      row.append(snip);
      return row;
    }));
  } catch (e) {
    note.textContent = 'Search failed: ' + e.message;
  } finally {
    searching = false;
  }
}

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('#deep-q').value); });

function paintToolbox() {
  if (view === 'mcp') paintMcp();
  else if (view === 'tools') paintTools();
  else if (view === 'rules') paintRules();
  else if (view === 'usage') paintUsage();
}

/* ------------------------------------------------------------------ views */

function setView(next) {
  view = next;
  store.set('view', view);
  // The usage pill is a tab too, just one that lives outside the segmented control.
  for (const b of document.querySelectorAll('#views button, #usage-pill')) {
    const isOn = b.dataset.view === view;
    b.classList.toggle('on', isOn);
    b.setAttribute('aria-selected', String(isOn));
  }
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== 'view-' + view;
  for (const el of document.querySelectorAll('.sessions-only')) el.hidden = view !== 'sessions';
  // Hide the whole label, not just the input, or its magnifier and its `/` badge float loose.
  document.querySelector('.search').hidden = view === 'usage' || view === 'search';
  $('#search').placeholder = view === 'sessions' ? 'filter by title, project, branch…'
    : view === 'mcp' ? 'filter servers…'
    : view === 'rules' ? 'filter memory, CLAUDE.md, hooks, permissions…'
    : 'filter skills, agents, commands…';
  if (view === 'search') { $('#deep-q').focus(); return; }
  if (view === 'usage') { if (usageData) paintUsage(); else loadUsage(); return; }
  if (view !== 'sessions' && !toolboxData) loadToolbox();
  else paintToolbox();
}

function jumpTo(id) {
  setView('sessions');
  if (!visible().some((s) => s.id === id)) {
    setFilter('all');
    delete dismissed[id];
    store.set('dismissed', dismissed);
    render();
  }
  select(id);
  const el = cards.get(id);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

/* ------------------------------------------------------------------ actions */

async function act(path, body, pending) {
  try { const r = await post(path, body); toast(pending.replace(/…$/, ''), r.opened || r.terminal || '', 'good'); }
  catch (e) { toast('Failed', e.message, 'bad'); }
}
