/* Rals Cockpit — a session card, and expanding one in place. Loaded after app-shots.js. */

/* -------------------------------------------------- expanding a card

   Rather than sending you to the transcript panel to find out what a session is doing, a card can
   unfold the last handful of messages in place. Each expanded card fetches its own slice and
   refetches only when that session's lastActivity moves, so an open card stays current without
   the board hammering the transcript endpoint every tick. */

const CARD_MESSAGES = 12;
const cardConvos = new Map();   // session id -> { at, loading }

function compactMsg(m) {
  const el = h('div', 'cmsg ' + m.role + (m.sidechain ? ' sidechain' : ''));
  el.append(h('span', 'cmsg-who', m.sidechain ? 'subagent' : m.role === 'user' ? (m.isToolTurn ? 'tool' : 'you') : 'claude'));
  const wrap = h('div', 'cmsg-body');
  if (m.text) wrap.append(h('p', 'cmsg-text', m.text));
  if (m.images?.length) wrap.append(h('p', 'cmsg-text dim', `🖼 ${m.images.length} image${m.images.length > 1 ? 's' : ''}`));
  if (m.tools?.length) {
    const tools = h('div', 'cmsg-tools');
    for (const t of m.tools.slice(0, 6)) {
      const chip = h('span', 'tool');
      chip.append(h('b', '', t.name));
      if (t.target) chip.append(document.createTextNode(' ' + clipText(t.target, 40)));
      tools.append(chip);
    }
    if (m.tools.length > 6) tools.append(h('span', 'used-label', `+${m.tools.length - 6}`));
    wrap.append(tools);
  }
  if (!m.text && !m.tools?.length && m.results) wrap.append(h('p', 'cmsg-text dim', `↩ ${m.results} tool result${m.results > 1 ? 's' : ''}`));
  el.append(wrap);
  return el;
}

async function loadCardConvo(id) {
  const state = cardConvos.get(id);
  if (state?.loading) return;
  const at = cur(id).lastActivity || 0;
  cardConvos.set(id, { at, loading: true });
  const box = cards.get(id)?.querySelector('.card-convo');
  if (box && !box.childElementCount) box.append(h('p', 'cmsg-note', 'loading…'));
  try {
    const res = await fetch(`/api/transcript?id=${encodeURIComponent(id)}&limit=${CARD_MESSAGES}`);
    const convo = await res.json();
    const target = cards.get(id)?.querySelector('.card-convo');
    cardConvos.set(id, { at, loading: false });
    if (!target) return;
    if (convo.error) { target.replaceChildren(h('p', 'cmsg-note', convo.error)); return; }
    const nodes = convo.items.map(compactMsg);
    target.replaceChildren(...nodes);
    if (convo.total > convo.items.length) {
      target.prepend(h('p', 'cmsg-note', `last ${convo.items.length} of ${convo.total}+ — open the transcript for the rest`));
    }
    target.scrollTop = target.scrollHeight;
  } catch (e) {
    cardConvos.set(id, { at, loading: false });
    cards.get(id)?.querySelector('.card-convo')?.replaceChildren(h('p', 'cmsg-note', 'could not read it: ' + e.message));
  }
}

function toggleExpand(id) {
  if (expanded[id]) delete expanded[id]; else expanded[id] = true;
  store.set('expanded', expanded);
  const el = cards.get(id);
  if (el) paintCard(el, cur(id));
}

/* ------------------------------------------------------------------ card */

function chip(text, cls, title) {
  const el = h('span', 'chip' + (cls ? ' ' + cls : ''), text);
  if (title) el.title = title;
  return el;
}

// A chip you can act on. `opens-menu` keeps the outside-click handler from closing it instantly.
function chipMenu(text, title, open) {
  const el = h('button', 'chip chip-menu opens-menu', text);
  el.title = title;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) { closePopover(); return; }
    open(el);
  });
  return el;
}

const ORIGIN_HINT = {
  terminal: 'started in a terminal — claude on the command line',
  vscode: 'started from the VS Code extension',
  desktop: 'started from the Claude desktop app',
  web: 'started from claude.ai',
  page: 'started here in this dashboard — there is no terminal behind it',
  unknown: 'nothing in the transcript says where this one began',
};

function chipsFor(s) {
  const out = [];
  out.push(chip(s.project, 'project', s.cwd));
  // Where it came from, always shown: a terminal, an editor, the app, or this page.
  if (s.origin) {
    out.push(chip(s.origin.label, 'origin origin-' + s.origin.key,
      ORIGIN_HINT[s.origin.key] || `entrypoint: ${s.origin.label}`));
  }
  if (s.gitBranch) out.push(chip(s.gitBranch, 'branch', 'git branch'));
  out.push(chipMenu(shortModel(s.model) || 'model', 'Model — click to reopen this chat on another one', (a) => openModelMenu(s, a)));
  out.push(chipMenu('effort ' + (s.effort || 'medium'), 'Effort — click to reopen this chat at another level', (a) => openEffortMenu(s, a)));
  if (s.permissionMode && s.permissionMode !== 'default') out.push(chip(s.permissionMode, '', 'permission mode'));
  if (s.queued) out.push(chip(s.queued + ' queued', 'queued', 'messages waiting in this session\'s queue'));
  if (s.subagentsRunning) out.push(chip(s.subagentsRunning + ' subagent' + (s.subagentsRunning > 1 ? 's' : ''), 'subagents', 'agents/workflows still running'));
  if (s.promptCount) out.push(chip(s.promptCount + '↑ / ' + s.turnCount + '↓', '', 'your prompts / Claude turns in the recent window'));
  if (s.tokens?.context) out.push(chip('ctx ' + kilo(s.tokens.context), '', 'context size on the last request'));
  for (const name of Object.keys(s.mcpUsed || {})) out.push(chip(name, 'mcp', 'MCP server used in this window'));
  for (const name of Object.keys(s.skillsUsed || {})) out.push(chip('/' + name, 'skill', 'skill invoked in this window'));
  if (s.inPage && s.inPageTurns) out.push(chip(`${s.inPageTurns} turn${s.inPageTurns > 1 ? 's' : ''} here`, 'inpage', 'messages you sent from this page'));
  out.push(chip(s.alive ? 'pid ' + s.pid : s.status === 'here' ? 'no terminal' : 'closed', '',
    s.alive ? (s.entrypoint || '') + ' · ' + (s.procName || '')
      : s.status === 'here' ? 'this chat runs in the page — send a message to continue it'
      : 'no live process'));
  return out;
}

function activityFor(s) {
  if (s.pendingTool) {
    const t = s.pendingTool;
    const secs = ago(t.since);
    const target = t.target ? ' → ' + t.target : '';
    if (s.status === 'blocked') return { html: true, text: `⏸ <b>${escape(t.name)}</b>${escape(target)} · pending ${secs} — likely waiting on your approval` };
    if (s.status === 'long') return { html: true, text: `⏱ <b>${escape(t.name)}</b>${escape(target)} · running ${secs}` };
    return { html: true, text: `⏳ <b>${escape(t.name)}</b>${escape(target)} · ${secs}` };
  }
  if (s.lastRole === 'assistant' && s.lastText) return { html: false, text: '↳ ' + s.lastText.replace(/\s+/g, ' ').slice(0, 180) };
  if (s.lastRole === 'user' && s.status === 'working') return { html: false, text: '⏳ thinking…' };
  return { html: false, text: '' };
}

/* Marking a chat idle is a claim about the chat, not about this browser, so it goes to the
   server and comes back on the next state push - which the server sends immediately. That
   also means the phone and the desktop never disagree about who is still waiting. */
async function toggleIdle(id) {
  const s = cur(id);
  if (!s.id || !s.alive) return;
  try { await post('/api/idle', { id, idle: !s.idleMarked }); }
  catch (e) { toast('Could not change that', e.message, 'bad'); }
}

function makeCard(s) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = s.id;
  const ta = el.querySelector('textarea');

  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', grow);
  // Ctrl+Enter sends; Enter is just a newline. (Plain Enter used to send, which meant reaching
  // for a second line launched a terminal you never asked for.)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFromCard(s.id, ta); }
  });
  el.querySelector('.send').addEventListener('click', () => sendFromCard(s.id, ta));
  wireShots(s.id, ta);

  el.querySelector('.act-transcript').addEventListener('click', () => openDrawer(s.id));
  const sectionsBtn = el.querySelector('.act-sections');
  sectionsBtn.classList.add('opens-menu');
  sectionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) { closePopover(); return; }
    openSectionMenu(s.id, sectionsBtn);
  });
  el.querySelector('.act-copy').addEventListener('click', () => copy(`claude --resume ${s.id}`));
  el.querySelector('.act-code').addEventListener('click', () => act('/api/open', { target: 'code', cwd: cur(s.id).cwd }, 'Opening VS Code…'));
  el.querySelector('.act-folder').addEventListener('click', () => act('/api/open', { target: 'explorer', cwd: cur(s.id).cwd }, 'Opening folder…'));
  el.querySelector('.act-idle').addEventListener('click', () => toggleIdle(s.id));
  el.querySelector('.act-dismiss').addEventListener('click', () => {
    dismissed[s.id] = cur(s.id).lastActivity; store.set('dismissed', dismissed); render();
  });
  el.querySelector('.act-forget').addEventListener('click', async () => {
    if (!confirm('Forget this chat?\n\nIt stops being pinned to the board as an in-page chat. The transcript itself is untouched.')) return;
    try { await post('/api/chat/forget', { id: s.id }); toast('Forgotten', 'the transcript is still there', 'good'); }
    catch (e) { toast('Could not forget it', e.message, 'bad'); }
  });
  el.querySelector('.card-expand').addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(s.id); });
  el.addEventListener('click', (e) => {
    if (e.target.closest('button, textarea')) return;
    select(s.id);
  });
  el.addEventListener('dblclick', (e) => { if (!e.target.closest('button, textarea, .card-convo')) toggleExpand(s.id); });
  return el;
}

function paintCard(el, s) {
  el.dataset.status = s.status;
  const set = (sel, text) => { const n = el.querySelector(sel); if (n.textContent !== text) n.textContent = text; };

  const slot = el.querySelector('.sprite-slot');
  if (slot.dataset.mood !== s.status) { slot.dataset.mood = s.status; slot.replaceChildren(PX.sprite(s.status)); }

  set('.title', s.title);
  set('.pill', LABEL[s.status] || s.status);

  // Queued messages get their own pill beside the status, not just a chip among twelve others.
  const q = el.querySelector('.qpill');
  q.hidden = !s.queued;
  if (s.queued) {
    q.textContent = `${s.queued} queued`;
    q.title = `${s.queued} message${s.queued > 1 ? 's' : ''} waiting in this session's own queue — it will pick them up when the current turn ends`;
  }
  el.querySelector('.pill').title = s.idleMarked
    ? 'You marked this one idle — it comes back by itself when the session next writes something'
    : '';
  el.classList.toggle('marked-idle', !!s.idleMarked);

  const rankEl = el.querySelector('.rank');
  const rankKey = s.rank ? String(s.rank) : '';
  if (rankEl.dataset.k !== rankKey) {
    rankEl.dataset.k = rankKey;
    rankEl.hidden = !s.rank;
    rankEl.replaceChildren();
    if (s.rank === 1) {
      rankEl.append(PX.caret(), document.createTextNode('next up'));
      rankEl.title = 'Longest-waiting session that needs you';
    } else if (s.rank) {
      rankEl.textContent = '#' + s.rank;
      rankEl.title = `${s.rank}${s.rank === 2 ? 'nd' : s.rank === 3 ? 'rd' : 'th'} in the queue of sessions waiting on you`;
    }
  }
  el.classList.toggle('first-up', s.rank === 1);

  const t = el.querySelector('.ago');
  t.textContent = ago(s.lastActivity);
  t.title = s.lastActivity ? new Date(s.lastActivity).toLocaleString() : '';

  const chips = el.querySelector('.chips');
  const signature = JSON.stringify([s.project, s.gitBranch, s.model, s.effort, s.permissionMode, s.queued,
    s.subagentsRunning, s.promptCount, s.turnCount, s.tokens?.context, s.alive, s.pid,
    s.origin?.key, s.inPageTurns,
    Object.keys(s.mcpUsed || {}), Object.keys(s.skillsUsed || {})]);
  if (chips.dataset.sig !== signature) {
    chips.dataset.sig = signature;
    chips.replaceChildren(...chipsFor(s));
  }

  const pathEl = el.querySelector('.path');
  const pathText = `${s.cwd || '(unknown cwd)'}   ${s.id.slice(0, 8)}`;
  if (pathEl.textContent !== pathText) { pathEl.textContent = pathText; pathEl.title = `${s.cwd}\nsession ${s.id}`; }

  set('.prompt', s.lastPrompt || '');
  const activity = activityFor(s);
  const an = el.querySelector('.activity');
  if (activity.html) { if (an.dataset.h !== activity.text) { an.dataset.h = activity.text; an.innerHTML = activity.text; } }
  else { delete an.dataset.h; if (an.textContent !== activity.text) an.textContent = activity.text; }

  // Expanded cards keep their slice fresh: refetch only when this session has moved on.
  const open = !!expanded[s.id];
  el.classList.toggle('open', open);
  const convo = el.querySelector('.card-convo');
  convo.hidden = !open;
  el.querySelector('.card-expand').title = open ? 'Hide the conversation (e)' : 'Show the recent conversation (e)';
  if (open) {
    const seen = cardConvos.get(s.id);
    if (!seen || (!seen.loading && seen.at !== s.lastActivity)) loadCardConvo(s.id);
  }

  shotTray(s.id, el.querySelector('.shots'));

  el.querySelector('.act-forget').hidden = !s.inPage;

  const mine = sectionList.filter((x) => x.members.includes(s.id));
  const sectionsBtn = el.querySelector('.act-sections');
  const label = mine.length ? `sections: ${mine.map((x) => x.name).join(', ')}` : 'sections';
  if (sectionsBtn.textContent !== label) sectionsBtn.textContent = label;
  sectionsBtn.classList.toggle('on', mine.length > 0);
  sectionsBtn.title = mine.length ? 'In ' + mine.map((x) => x.name).join(', ') : 'Add this chat to a section';

  // Only live chats can be marked — an ended one is out of the queue already.
  const idleBtn = el.querySelector('.act-idle');
  idleBtn.hidden = !s.alive;
  const idleLabel = s.idleMarked ? 'idle — undo' : 'mark idle';
  if (idleBtn.textContent !== idleLabel) idleBtn.textContent = idleLabel;
  idleBtn.classList.toggle('on', !!s.idleMarked);
  idleBtn.title = s.idleMarked
    ? 'Marked idle by you (i).\nBack in the counts the moment this session writes anything new.'
    : 'Done with this one for now (i).\nIt leaves "needs me" and the queue but stays on the board,\nand returns by itself when the session next moves.';

  const sendBtn = el.querySelector('.send');
  const ta = el.querySelector('textarea');
  if (s.alive) {
    sendBtn.textContent = 'Send';
    ta.placeholder = 'Reply — Ctrl+Enter to send…';
    ta.title = 'Ctrl+Enter sends; Enter just starts a new line.\nSending opens a new terminal resuming this session with your message.\nThe window already running this session keeps its own state.\nPaste or drop images to send them along.';
  } else {
    sendBtn.textContent = 'Resume';
    ta.placeholder = 'Resume this chat — Ctrl+Enter to send…';
    ta.title = 'Ctrl+Enter sends; Enter just starts a new line.\nOpens a terminal, resumes this session, and sends your message.\nPaste or drop images to send them along.';
  }
}
