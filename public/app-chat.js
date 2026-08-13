/* Rals Cockpit — the in-page chat. Loaded after app-search.js. */

/* -------------------------------------------------- in-page chat

   The answer arrives in this page instead of a terminal: the server runs Claude headless with
   --output-format stream-json and relays the events over SSE. The one thing print mode cannot
   do is ask you about a tool call, so what it is allowed to touch is agreed before it starts. */

/* Several chats can be in flight at once: each run keeps its own live node, its own event source
   and its own pill. `chatRun` is just whichever one the open panel is showing. */
const chatRuns = new Map();   // sessionId -> { runId, es, node, text, status, title, sessionId }
let chatRun = null;           // the run belonging to the panel on screen, if any
let newChatMode = false;
// Attachments hang off the session id, or off 'new' before a new chat has one.
const composeKey = () => drawerId || 'new';
let chatStance = store.get('stance', 'read');
let chatModel = store.get('chatmodel', '');
let chatEffort = store.get('chateffort', '');

const running = () => !!chatRun;                 // is the panel's own chat mid-answer?
const runFor = (id) => chatRuns.get(id) || null;  // is *that* chat mid-answer, panel or not?

function fillChatSelects() {
  const model = $('#chat-model');
  model.replaceChildren(h('option', '', 'session default'));
  model.firstChild.value = '';
  for (const m of MODELS) { const o = h('option', '', m); o.value = m; model.append(o); }
  model.value = chatModel;

  const effort = $('#chat-effort');
  effort.replaceChildren(h('option', '', 'session default'));
  effort.firstChild.value = '';
  for (const e of EFFORTS) { const o = h('option', '', e); o.value = e; effort.append(o); }
  effort.value = chatEffort;

  $('#chat-stance').value = chatStance;
}

function folderOptions() {
  const seen = new Map();
  for (const s of sessions) if (s.cwd) seen.set(s.cwd.toLowerCase(), s.cwd);
  for (const p of toolboxData?.projects || []) if (p.dir) seen.set(p.dir.toLowerCase(), p.dir);
  const select = $('#new-folder');
  const chosen = select.value;
  select.replaceChildren();
  for (const dir of [...seen.values()].sort((a, b) => a.localeCompare(b))) {
    const o = h('option', '', `${dir.split(/[\\/]/).filter(Boolean).pop()}  —  ${dir}`);
    o.value = dir;
    select.append(o);
  }
  if (chosen) select.value = chosen;
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
  el.append(h('div', 'msg-head', 'claude · now'));
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

  const cwd = drawerId ? (cur(drawerId).cwd || $('#new-folder').value) : $('#new-folder').value;
  if (!cwd) { toast('Pick a folder for the chat', '', 'bad'); return; }

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
