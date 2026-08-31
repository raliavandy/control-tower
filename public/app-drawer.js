/* Rals Cockpit — the conversation panel. Loaded after app-chat.js. */

/* ------------------------------------------------------------------ drawer */

let drawerId = null;
let drawerConvo = null;
let drawerWho = store.get('drawerwho', 'all');
let drawerFind = '';
let drawerLimit = 80;

const isYours = (m) => m.role === 'user' && !m.isToolTurn && !m.sidechain;

async function openDrawer(id) {
  if ($('#drawer').hidden) lastFocus = document.activeElement;
  drawerId = id;
  drawerConvo = null;
  drawerLimit = 80;
  drawerFind = '';
  newChatMode = false;
  applyProviderChrome();
  // The panel adopts whichever run belongs to the chat being opened, if any.
  chatRun = runFor(id);
  const mine = !!chatRun;
  $('#drawer-send').disabled = mine;
  $('#drawer-stop').hidden = !mine;
  paintRunPill();
  $('#drawer-find').value = '';
  $('.drawer-tools').hidden = false;
  for (const el of document.querySelectorAll('.newchat-only')) el.hidden = true;
  setRunStatus('');
  const s = cur(id);
  $('#drawer').hidden = false; $('#scrim').hidden = false;
  $('#drawer-title').textContent = s.title || id;
  $('#drawer-sub').textContent = `${s.project || ''}${s.gitBranch ? ' · ' + s.gitBranch : ''} · ${id}`;
  $('#drawer-body').textContent = 'loading…';
  await loadTranscript();
  if (mine) setRunStatus(chatRun.status || 'answering…', 'go');
  shotTray(id, $('#drawer-shots'));
}

// A run collapsed and reopened still owns its live turn, so it is re-attached whatever happens.
function reattachLive() {
  const run = runFor(drawerId);
  if (run?.node) $('#drawer-body').append(run.node.el);
}

async function loadTranscript() {
  try {
    const res = await fetch(`/api/transcript?id=${encodeURIComponent(drawerId)}&limit=${drawerLimit}`);
    const convo = await res.json();
    if (convo.error) throw new Error(convo.error);
    drawerConvo = convo;
    paintDrawer();
  } catch (e) {
    drawerConvo = null;
    // A brand new chat has no transcript until its first turn lands - that is not an error.
    const firstTurn = !!runFor(drawerId);
    $('#drawer-body').replaceChildren(h('p', 'drawer-hint',
      firstTurn ? 'Still on its first answer — the saved transcript appears once this turn finishes.'
        : 'Could not read the transcript: ' + e.message));
    reattachLive();
  }
}

/* Filter the loaded window down to your own prompts, Claude's turns, or a text match. */
function paintDrawer(scrollTo) {
  const body = $('#drawer-body');
  if (!drawerConvo) return;
  const q = drawerFind.trim().toLowerCase();
  const all = drawerConvo.items;

  const yours = all.filter(isYours).length;
  $('#c-you').textContent = yours;

  const kept = all
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      if (drawerWho === 'you' && !isYours(m)) return false;
      if (drawerWho === 'claude' && !(m.role === 'assistant' && !m.sidechain)) return false;
      if (!q) return true;
      const hay = (m.text || '') + ' ' + m.tools.map((t) => t.name + ' ' + t.target).join(' ');
      return hay.toLowerCase().includes(q);
    });

  const label = assistantLabel(drawerId ? cur(drawerId).provider : activeProvider());
  body.replaceChildren(...kept.map(({ m, i }) => msgNode(m, i, q, drawerWho !== 'all' || !!q, label)));
  reattachLive();

  const filtering = drawerWho !== 'all' || q;
  $('#drawer-count').textContent = filtering
    ? `${kept.length} of ${all.length} shown`
    : `${all.length} message${all.length === 1 ? '' : 's'}${drawerConvo.total > all.length ? ` · ${drawerConvo.total}+ in this chat` : ''}`;

  const more = $('#drawer-more');
  more.hidden = !(drawerConvo.total > all.length);
  more.textContent = `load ${Math.min(400, drawerLimit * 3) - drawerLimit} more`;

  if (scrollTo !== undefined) {
    const target = body.querySelector(`[data-i="${scrollTo}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
      return;
    }
  }
  // Reading your own questions works top-down; the raw log reads bottom-up.
  body.scrollTop = filtering ? 0 : body.scrollHeight;
}

// Wraps every occurrence of `q` in <mark>, without ever putting untrusted text through innerHTML.
function withMarks(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(document.createTextNode(text)); return frag; }
  const lower = text.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = lower.indexOf(q, at);
    if (hit < 0) break;
    if (hit > at) frag.append(document.createTextNode(text.slice(at, hit)));
    frag.append(h('mark', '', text.slice(hit, hit + q.length)));
    at = hit + q.length;
  }
  frag.append(document.createTextNode(text.slice(at)));
  return frag;
}

function msgNode(m, index, q, jumpable, assistant) {
  const el = h('div', 'msg ' + m.role + (m.sidechain ? ' sidechain' : ''));
  el.dataset.i = index;
  const head = h('div', 'msg-head', (m.sidechain ? 'subagent · ' : '') + (m.role === 'user' ? (m.isToolTurn ? 'tool result' : 'you') : (assistant || 'claude')));
  if (m.ts) head.append(h('span', '', new Date(m.ts).toLocaleTimeString()));
  if (jumpable) {
    const jump = h('button', 'msg-jump', 'show in context');
    jump.addEventListener('click', () => {
      drawerWho = 'all'; store.set('drawerwho', 'all');
      drawerFind = ''; $('#drawer-find').value = '';
      paintWhoTabs();
      paintDrawer(index);
    });
    head.append(h('span', 'spacer'), jump);
  }
  el.append(head);
  if (m.text) {
    const p = h('p', 'msg-text');
    p.append(withMarks(m.text, q));
    el.append(p);
  }
  // Fetched one at a time from /api/image rather than inlined - a screenshot is megabytes.
  if (m.images?.length) {
    const wrap = h('div', 'msg-shots');
    for (const ref of m.images) {
      const href = `/api/image?id=${encodeURIComponent(drawerId)}&uuid=${encodeURIComponent(ref.uuid)}&b=${ref.b}`;
      const link = document.createElement('a');
      link.className = 'msg-shot';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.title = 'Open full size';
      const img = document.createElement('img');
      img.src = href;
      img.alt = 'image in this message';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => link.replaceChildren(h('span', 'msg-shot-missing', 'image could not be read')));
      link.append(img);
      wrap.append(link);
    }
    el.append(wrap);
  }
  if (m.tools.length) {
    const wrap = h('div', 'msg-tools');
    for (const t of m.tools) {
      const c = h('span', 'tool');
      c.append(h('b', '', t.name));
      if (t.target) c.append(document.createTextNode(' ' + t.target));
      wrap.append(c);
    }
    el.append(wrap);
  }
  if (!m.text && !m.tools.length && m.results) {
    el.append(h('p', 'msg-text', `↩ ${m.results} tool result${m.results > 1 ? 's' : ''}`));
  }
  return el;
}

function paintWhoTabs() {
  for (const b of document.querySelectorAll('#drawer-who button')) b.classList.toggle('on', b.dataset.who === drawerWho);
}

/* Collapsing mid-answer is fine: the run lives on the server, which buffers its events and
   replays them to whoever subscribes next. So the panel closes, a pill takes over, and the live
   turn keeps filling in behind the scenes. */
function closeDrawer() {
  $('#drawer').hidden = true; $('#scrim').hidden = true;
  if (!running()) { drawerId = null; drawerConvo = null; newChatMode = false; }
  chatRun = null;                  // the run carries on; the panel just stops showing it
  paintRunPill();
  lastFocus?.focus?.();            // hand focus back where it came from
  lastFocus = null;
}

/* One pill per run that isn't the one on screen, stacked bottom-right. */
function paintRunPill() {
  const tray = $('#runtray');
  const hiddenRuns = [...chatRuns.values()].filter((r) => $('#drawer').hidden || r.sessionId !== drawerId);
  tray.hidden = !hiddenRuns.length;
  tray.replaceChildren(...hiddenRuns.map((run) => {
    const s = cur(run.sessionId);
    const pill = h('div', 'runpill');
    pill.append(h('span', 'runpill-dot'));
    const copy = h('span', 'runpill-copy');
    copy.append(h('b', '', s.title || run.title || 'chat'));
    copy.append(h('small', '', run.status || 'answering…'));
    pill.append(copy);
    const open = h('button', 'runpill-open', 'open');
    open.setAttribute('aria-label', `Open ${s.title || run.title || 'this chat'}`);
    open.addEventListener('click', () => openDrawer(run.sessionId));
    const stop = h('button', 'runpill-stop', 'stop');
    stop.setAttribute('aria-label', 'Stop this run');
    stop.addEventListener('click', async () => {
      try { await post('/api/chat/stop', { run: run.runId }); toast('Stopped'); }
      catch (e) { toast('Could not stop it', e.message, 'bad'); }
    });
    pill.append(open, stop);
    return pill;
  }));
}

paintWhoTabs();
for (const b of document.querySelectorAll('#drawer-who button')) {
  b.addEventListener('click', () => {
    drawerWho = b.dataset.who;
    store.set('drawerwho', drawerWho);
    paintWhoTabs();
    paintDrawer();
  });
}
$('#drawer-find').addEventListener('input', (e) => { drawerFind = e.target.value; paintDrawer(); });
$('#drawer-more').addEventListener('click', async () => {
  drawerLimit = Math.min(400, drawerLimit * 3);
  $('#drawer-more').disabled = true;
  await loadTranscript();
  $('#drawer-more').disabled = false;
});

$('#drawer-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#drawer-send').addEventListener('click', sendChat);
$('#drawer-reply').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
});
$('#drawer-stop').addEventListener('click', async () => {
  if (!chatRun) return;
  try { await post('/api/chat/stop', { run: chatRun.runId }); toast('Stopped'); }
  catch (e) { toast('Could not stop it', e.message, 'bad'); }
});
// The escape hatch: the real interactive TUI, for anything print mode cannot do.
$('#drawer-terminal').addEventListener('click', () => {
  const ta = $('#drawer-reply');
  const cwd = drawerId ? (cur(drawerId).cwd || $('#new-folder').value) : $('#new-folder').value;
  const body = { cwd, message: ta.value.trim(), images: shotsOf(composeKey()), model: chatModel || undefined, effort: chatEffort || undefined };
  if (drawerId) body.id = drawerId;
  act(drawerId ? '/api/reply' : '/api/new-terminal', body, 'Opening a terminal…');
  ta.value = '';
});

$('#btn-new').addEventListener('click', openNewChat);

$('#drawer-export').addEventListener('click', () => {
  if (!drawerId) return;
  // A plain link download, so the browser handles the save dialog.
  const a = document.createElement('a');
  a.href = `/api/export?id=${encodeURIComponent(drawerId)}`;
  a.download = `chat-${drawerId.slice(0, 8)}.md`;
  a.click();
  toast('Exported as Markdown', cur(drawerId).title || drawerId, 'good');
});

$('#chat-stance').addEventListener('change', (e) => {
  chatStance = e.target.value; store.set('stance', chatStance);
  if (chatStance === 'full') toast('No prompts at all', 'It will run any tool without asking. Use it deliberately.', 'bad');
});
$('#chat-model').addEventListener('change', (e) => { chatModel = e.target.value; store.set('chatmodel', chatModel); });
$('#chat-effort').addEventListener('change', (e) => { chatEffort = e.target.value; store.set('chateffort', chatEffort); });
fillChatSelects();
// The drawer box is reused across sessions, so it attaches to whichever one is open.
(() => {
  const ta = $('#drawer-reply');
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => addShot(composeKey(), f));
  });
  ta.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    ta.classList.add('dropping');
  });
  ta.addEventListener('dragleave', () => ta.classList.remove('dropping'));
  ta.addEventListener('drop', (e) => {
    ta.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => addShot(composeKey(), f));
  });
})();
