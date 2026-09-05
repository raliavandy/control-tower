/* Control Tower — the in-page chat. Loaded after app-search.js. */

/* -------------------------------------------------- in-page chat

   The answer arrives in this page instead of a terminal: the server runs Claude headless with
   --output-format stream-json and relays the events over SSE. The one thing print mode cannot
   do is ask you about a tool call, so what it is allowed to touch is agreed before it starts. */

/* Several chats can be in flight at once: each run keeps its own live node, its own event source
   and its own pill. `chatRun` is just whichever one the open panel is showing. */
const chatRuns = new Map();   // sessionId -> { runId, es, node, text, status, title, sessionId }
let chatRun = null;           // the run belonging to the panel on screen, if any
let newChatMode = false;
let newChatProvider = 'claude';
// Attachments hang off the session id, or off 'new' before a new chat has one.
const composeKey = () => drawerId || 'new';
let chatStance = store.get('stance', 'read');
let chatModel = store.get('chatmodel', '');
let chatEffort = store.get('chateffort', '');

const running = () => !!chatRun;                 // is the panel's own chat mid-answer?
const runFor = (id) => chatRuns.get(id) || null;  // is *that* chat mid-answer, panel or not?

// Which provider the open panel is actually about: an existing chat's own provider, or whichever
// one is picked in the New Chat dropdown.
const activeProvider = () => (drawerId ? (cur(drawerId).provider || 'claude') : newChatProvider);

async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    providers = await res.json();
  } catch (e) {
    toast('Could not read provider settings', e.message, 'bad');
  }
  fillProviderSelect();
  if (!$('#drawer').hidden) applyProviderChrome();
}

function fillProviderSelect() {
  const select = $('#new-provider');
  const chosen = select.value || newChatProvider;
  select.replaceChildren();
  for (const [id, p] of Object.entries(providers)) {
    const needsKey = p.kind === 'api-key' && !p.configured;
    const o = h('option', '', p.label + (needsKey ? ' — needs an API key' : ''));
    o.value = id;
    select.append(o);
  }
  select.value = providers[chosen] ? chosen : 'claude';
  newChatProvider = select.value;
}

$('#new-provider').addEventListener('change', (e) => {
  newChatProvider = e.target.value;
  const p = providers[newChatProvider];
  if (p?.kind === 'api-key' && !p.configured) {
    toast(`No ${p.label} key saved yet`, 'Add one from the ⋯ menu, then come back here.', 'bad');
  }
  applyProviderChrome();
});

// Everything about the panel's chrome that depends on what the current provider can actually
// do: a folder only means something to a local CLI, "can" (permission stance) only applies where
// print mode can't ask about a tool call, and "open in terminal" needs a terminal to open.
function applyProviderChrome() {
  const caps = providerOf({ provider: activeProvider() });
  $('#new-folder-field').hidden = !newChatMode || !caps.hasFolder;
  $('#chat-stance-field').hidden = !caps.hasStance;
  $('#chat-effort-field').hidden = !(caps.efforts === null || caps.efforts.length);
  $('#drawer-terminal').hidden = !caps.canResumeInTerminal;
  fillChatSelects();
}

function fillSelect(select, items, current) {
  select.replaceChildren(h('option', '', 'session default'));
  select.firstChild.value = '';
  for (const item of items) { const o = h('option', '', item); o.value = item; select.append(o); }
  select.value = current;
}

function fillChatSelects() {
  const caps = providerOf({ provider: activeProvider() });
  fillSelect($('#chat-model'), caps.models || MODELS, chatModel);
  fillSelect($('#chat-effort'), caps.efforts === null ? EFFORTS : caps.efforts, chatEffort);
  $('#chat-stance').value = chatStance;
}

function folderOptions() {
  const seen = new Map();
  for (const s of sessions) if (s.cwd) seen.set(s.cwd.toLowerCase(), s.cwd);
  for (const p of toolboxData?.projects || []) if (p.dir) seen.set(p.dir.toLowerCase(), p.dir);
  // A <datalist>, not a <select>: known folders still autocomplete, but there's always a way to
  // type one that isn't known yet - a brand new install with no session or project history yet
  // would otherwise leave this with nothing to pick and no way to start a first chat at all.
  const list = $('#new-folder-list');
  const field = $('#new-folder');
  const chosen = field.value;
  list.replaceChildren();
  for (const dir of [...seen.values()].sort((a, b) => a.localeCompare(b))) {
    const o = document.createElement('option');
    o.value = dir;
    o.label = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    list.append(o);
  }
  if (chosen) field.value = chosen;
}

function setRunStatus(text, kind) {
  const el = $('#run-status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'run-status' + (kind ? ' ' + kind : '');
}

// One live turn, rendered as it arrives, then replaced by the canonical transcript at the end.
function liveTurn() {
  const el = h('div', 'msg assistant live');
  el.append(h('div', 'msg-head', assistantLabel(activeProvider()) + ' · now'));
  const text = h('p', 'msg-text');
  const tools = h('div', 'msg-tools');
  el.append(text, tools);
  $('#drawer-body').append(el);
  el.scrollIntoView({ block: 'end' });
  return { el, text, tools };
}

function onChatEvent(e, run) {
  if (!run) return;
  const body = $('#drawer-body');
  const onScreen = !$('#drawer').hidden && drawerId === run.sessionId;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  // Status writes to the panel only when this run is the one being looked at.
  const status = (text, kind) => {
    run.status = text;
    if (onScreen) setRunStatus(text, kind);
    paintRunPill();
  };

  if (e.type === 'system' && e.subtype === 'init') {
    // A brand new chat only learns its id here; adopt it so the next send resumes it.
    if (e.session_id && e.session_id !== run.sessionId) {
      chatRuns.delete(run.sessionId);
      run.sessionId = e.session_id;
      chatRuns.set(run.sessionId, run);
    }
    if (!drawerId && e.session_id) {
      drawerId = e.session_id;
      $('#drawer-sub').textContent = `${e.cwd || ''} · ${e.session_id}`;
    }
    status(`running · ${run.stance} · ${e.model || ''}`.trim(), 'go');
  } else if (e.type === 'system' && e.subtype === 'status') {
    status(`${e.status}…`, 'go');
  } else if (e.type === 'fleet_text') {
    // The buffered form of a whole answer, replayed when reopening mid-stream.
    run.text = e.text;
    run.node.text.textContent = run.text;
  } else if (e.type === 'fleet_note') {
    run.node.tools.append(h('span', 'used-label', e.text));
  } else if (e.type === 'stream_event') {
    const ev = e.event || {};
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      run.text += ev.delta.text;
      run.node.text.textContent = run.text;
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
      status('thinking…', 'go');
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      const chip = h('span', 'tool');
      chip.append(h('b', '', ev.content_block.name || 'tool'));
      run.node.tools.append(chip);
      status(`${ev.content_block.name}…`, 'go');
    }
  } else if (e.type === 'assistant') {
    // The full message is authoritative for tool names and their targets.
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    const uses = blocks.filter((b) => b?.type === 'tool_use');
    if (uses.length) {
      run.node.tools.replaceChildren();
      for (const u of uses) {
        const chip = h('span', 'tool');
        chip.append(h('b', '', u.name));
        run.node.tools.append(chip);
      }
    }
  } else if (e.type === 'stderr') {
    status(e.text, 'bad');
  } else if (e.type === 'result') {
    // Kept for plans that bill per request; on a subscription this is always zero.
    if (typeof e.total_cost_usd === 'number' && e.total_cost_usd > 0) run.cost = e.total_cost_usd;
  } else if (e.type === 'fleet_end') {
    endChat(e, run);
    return;
  }
  if (onScreen && atBottom) body.scrollTop = body.scrollHeight;
}

function endChat(e, forRun) {
  const run = forRun || chatRun;
  if (!run) return;
  const onScreen = !$('#drawer').hidden && drawerId === run.sessionId;
  chatRuns.delete(run.sessionId);
  if (chatRun === run) chatRun = null;
  run.es?.close();
  if (onScreen) {
    $('#drawer-send').disabled = false;
    $('#drawer-stop').hidden = true;
  }
  paintRunPill();

  if (e && !e.ok) {
    if (onScreen) setRunStatus(e.error || 'that run failed', 'bad');
    if (run.node && !run.text) run.node.el.remove();
    toast('That run failed', e.error || '', 'bad');
    return;
  }
  if (onScreen) setRunStatus('');
  run.node?.el.remove();            // the transcript below is the canonical version now
  loadUsage();

  if (onScreen) { loadTranscript(); return; }

  // Off-screen: say so rather than finishing silently, in the page and on the desktop.
  const label = cur(run.sessionId).title || run.title || 'that chat';
  const open = h('div', 'toast good', 'Answer ready');
  open.append(h('small', '', label + ' — click to read it'));
  open.style.cursor = 'pointer';
  open.addEventListener('click', () => { open.remove(); openDrawer(run.sessionId); });
  $('#toasts').append(open);
  setTimeout(() => open.remove(), 30000);
  if (notify && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('Answer ready', { body: label, tag: 'answer-' + run.sessionId });
    n.onclick = () => { window.focus(); openDrawer(run.sessionId); n.close(); };
  }
}

async function sendChat() {
  if (running()) return;                       // this conversation is already mid-answer
  const ta = $('#drawer-reply');
  const message = ta.value.trim();
  const key = composeKey();
  const images = shotsOf(key);
  if (!message && !images.length) { ta.focus(); return; }

  const provider = activeProvider();
  const caps = providerOf({ provider });
  const cwd = drawerId ? (cur(drawerId).cwd || $('#new-folder').value) : $('#new-folder').value;
  if (caps.hasFolder && !cwd) { toast('Pick a folder for the chat', '', 'bad'); return; }

  // Show your own message straight away rather than waiting for the transcript to catch up.
  const mine = h('div', 'msg user');
  mine.append(h('div', 'msg-head', 'you · now'));
  if (message) mine.append(h('p', 'msg-text', message));
  $('#drawer-body').append(mine);

  $('#drawer-send').disabled = true;
  setRunStatus('starting…', 'go');
  try {
    const r = await post('/api/chat', {
      id: drawerId || null, cwd, message, images,
      model: chatModel || undefined, effort: chatEffort || undefined, stance: chatStance,
      provider: drawerId ? undefined : provider,
    });
    ta.value = ''; ta.style.height = 'auto';
    shots.delete(key); shotTray(composeKey(), $('#drawer-shots')); paintShots(key);
    const run = {
      runId: r.runId, stance: r.stance, text: '', node: liveTurn(), cost: null,
      sessionId: drawerId || r.sessionId,
      // A new chat has no title yet, so its pill borrows the question.
      title: cur(drawerId).title || (message ? clipText(message, 42) : 'new chat'),
      status: 'starting…',
    };
    chatRun = run;
    chatRuns.set(run.sessionId, run);
    $('#drawer-stop').hidden = false;
    const es = new EventSource(`/api/chat/events?run=${encodeURIComponent(r.runId)}`);
    run.es = es;
    // Events carry their run, so a second conversation answering at the same time cannot
    // write into this one's node.
    es.onmessage = (m) => { try { onChatEvent(JSON.parse(m.data), run); } catch { /* keep going */ } };
    es.onerror = () => { if (chatRuns.get(run.sessionId) === run) endChat({ ok: true }, run); };
  } catch (err) {
    mine.remove();
    $('#drawer-send').disabled = false;
    setRunStatus(err.message, 'bad');
    toast('Could not start that chat', err.message, 'bad');
  }
}

function openNewChat() {
  // The chat on screen, if any, keeps running server-side and picks up a pill - same hand-off
  // openDrawer() already does when you switch to a different existing session mid-answer.
  chatRun = null;
  drawerId = null;
  drawerConvo = null;
  newChatMode = true;
  $('#drawer').hidden = false; $('#scrim').hidden = false;
  $('#drawer-title').textContent = 'New chat';
  $('#drawer-sub').textContent = 'runs right here — pick a folder and ask';
  $('#drawer-body').replaceChildren(h('p', 'drawer-hint', 'Nothing here yet. Your question and the answer will appear in this panel.'));
  $('.drawer-tools').hidden = true;
  for (const el of document.querySelectorAll('.newchat-only')) el.hidden = false;
  $('#drawer-send').disabled = false;
  $('#drawer-stop').hidden = true;
  fillProviderSelect();
  applyProviderChrome();
  folderOptions();
  setRunStatus('');
  paintRunPill();
  shotTray(composeKey(), $('#drawer-shots'));
  $('#drawer-reply').focus();
}

/* A card's reply box hands off to the drawer, so there is one place where a conversation
   happens and you can actually watch the answer arrive. */
async function sendFromCard(id, ta) {
  const message = ta.value.trim();
  const images = shotsOf(id);
  if (!message && !images.length) { ta.focus(); return; }
  if (running()) return toast('Wait for the current answer to finish', '', 'bad');
  ta.value = ''; ta.style.height = 'auto';
  await openDrawer(id);
  $('#drawer-reply').value = message;
  shots.set(id, images);
  shotTray(id, $('#drawer-shots'));
  paintShots(id);
  await sendChat();
}

/* -------------------------------------------------- provider API keys

   A small modal of its own rather than folding into the file editor: an API key isn't a file
   on disk to browse or diff against a backup, just one value to set, test and clear. */

let keyModalProvider = null;

function openKeyModal(providerId) {
  keyModalProvider = providerId;
  const p = providers[providerId];
  $('#key-title').textContent = `${p?.label || providerId} API key`;
  $('#key-input').value = '';
  $('#key-input').placeholder = p?.configured ? 'already set — paste a new one to replace it' : 'sk-…';
  $('#key-status').textContent = '';
  $('#key-status').className = 'ed-note';
  $('#key-delete').hidden = !p?.configured;
  $('#key-modal').hidden = false;
  $('#key-scrim').hidden = false;
  $('#key-input').focus();
}

function closeKeyModal() {
  $('#key-modal').hidden = true;
  $('#key-scrim').hidden = true;
  keyModalProvider = null;
}

function keyStatus(text, kind) {
  const el = $('#key-status');
  el.textContent = text;
  el.className = 'ed-note' + (kind ? ' ' + kind : '');
}

$('#key-close').addEventListener('click', closeKeyModal);
$('#key-scrim').addEventListener('click', closeKeyModal);

$('#key-test').addEventListener('click', async () => {
  const key = $('#key-input').value.trim();
  keyStatus('testing…');
  try {
    const r = await post('/api/provider-keys/test', { provider: keyModalProvider, key: key || undefined });
    keyStatus(r.ok ? 'works' : (r.error || 'that did not work'), r.ok ? 'good' : 'bad');
  } catch (e) {
    keyStatus(e.message, 'bad');
  }
});

$('#key-save').addEventListener('click', async () => {
  const key = $('#key-input').value.trim();
  if (!key) { keyStatus('paste a key first', 'bad'); return; }
  try {
    await post('/api/provider-keys', { provider: keyModalProvider, key });
    toast('Saved', providers[keyModalProvider]?.label || keyModalProvider, 'good');
    closeKeyModal();
    loadProviders();
  } catch (e) {
    keyStatus(e.message, 'bad');
  }
});

$('#key-delete').addEventListener('click', async () => {
  if (!confirm('Remove this key? Chats with this provider will stop working until you add one back.')) return;
  try {
    await post('/api/provider-keys/delete', { provider: keyModalProvider });
    toast('Removed', '', 'good');
    closeKeyModal();
    loadProviders();
  } catch (e) {
    keyStatus(e.message, 'bad');
  }
});
