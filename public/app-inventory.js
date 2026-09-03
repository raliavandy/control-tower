/* Rals Cockpit — the MCP / Skills / Rules panels and their editors. Loaded after app-menus.js. */

/* ------------------------------------------------------------------ toolbox panels */

let toolboxData = null;
let toolboxLoading = false;

async function loadToolbox() {
  if (toolboxLoading) return;
  toolboxLoading = true;
  try {
    const res = await fetch('/api/toolbox');
    toolboxData = await res.json();
  } catch (e) {
    toast('Could not read your Claude config', e.message, 'bad');
  } finally {
    toolboxLoading = false;
  }
  paintToolbox();
}

// What each session actually reached for, keyed loosely so "claude.ai Atlassian" finds
// the configured "claude.ai Atlassian Rovo".
function usageIndex(field) {
  const map = new Map();
  for (const s of sessions) {
    for (const [name, n] of Object.entries(s[field] || {})) {
      const k = idKey(name);
      let e = map.get(k);
      if (!e) { e = { label: name, calls: 0, sessions: [] }; map.set(k, e); }
      e.calls += n;
      if (!e.sessions.some((x) => x.id === s.id)) e.sessions.push(s);
    }
  }
  return map;
}

function matchUsage(map, name) {
  const k = idKey(name);
  if (map.has(k)) return { key: k, ...map.get(k) };
  for (const [uk, v] of map) if (uk.startsWith(k) || k.startsWith(uk)) return { key: uk, ...v };
  return null;
}

function sessionChips(list) {
  const wrap = h('div', 'used-by');
  wrap.append(h('span', 'used-label', 'used by'));
  for (const s of list.slice(0, 3)) {
    const b = h('button', 'chip session-chip', s.title.length > 26 ? s.title.slice(0, 26) + '…' : s.title);
    b.title = `${s.project || ''} · ${s.id}\nJump to this session`;
    b.addEventListener('click', () => jumpTo(s.id));
    wrap.append(b);
  }
  if (list.length > 3) {
    const more = h('button', 'chip session-chip', `+${list.length - 3} more`);
    more.title = list.slice(3).map((s) => s.title).join('\n');
    more.addEventListener('click', () => { query = ''; $('#search').value = ''; jumpTo(list[3].id); });
    wrap.append(more);
  }
  return wrap;
}

function invRow({ title, subtitle, badges, meta, target, usage, file, copyText, edit, remove, history }) {
  const row = h('article', 'inv');
  const head = h('div', 'inv-head');
  const name = h('button', 'inv-name', title);
  name.title = copyText ? `Copy ${copyText}` : title;
  if (copyText) name.addEventListener('click', () => copy(copyText));
  head.append(name);
  for (const b of badges || []) if (b) head.append(h('span', 'badge ' + (b.cls || ''), b.text));
  head.append(h('span', 'spacer'));
  if (usage) head.append(h('span', 'badge used', `${usage.calls} call${usage.calls > 1 ? 's' : ''}`));
  row.append(head);
  if (subtitle) row.append(h('p', 'inv-desc', subtitle));
  if (target) row.append(h('p', 'inv-target', target));
  if (meta) row.append(h('p', 'inv-meta', meta));
  if (usage?.sessions?.length) row.append(sessionChips(usage.sessions));
  if (file || edit || remove || history) {
    const tools = h('div', 'inv-tools');
    if (edit) tools.append(editLink('edit', edit));
    if (remove) tools.append(editLink('remove', remove));
    if (history) tools.append(editLink('history', history));
    if (file) {
      const open = h('button', 'link', 'open ' + file.split(/[\\/]/).pop());
      open.title = file;
      open.addEventListener('click', () => act('/api/open', { target: 'file', file }, 'Opening…'));
      tools.append(open);
    }
    row.append(tools);
  }
  return row;
}

/* -------------------------------------------------- editing rules, skills, MCP servers

   The server only accepts a path it already published in the inventory, so these buttons pass
   the row's own `file` back rather than composing paths here. Marketplace copies are read-only:
   editing one is undone by the next plugin update, so it is not offered. */

let editing = null;   // { mode: 'text' | 'mcp', file, row }

const modalOpen = () => !$('#editor').hidden;

function closeEditor() {
  $('#editor').hidden = true;
  $('#ed-scrim').hidden = true;
  editing = null;
  lastFocus?.focus?.();
  lastFocus = null;
}

function showEditor({ mode, title, sub, note, canDelete, canHistory }) {
  if ($('#editor').hidden) lastFocus = document.activeElement;
  $('#editor').hidden = false;
  $('#ed-scrim').hidden = false;
  $('#ed-title').textContent = title;
  $('#ed-sub').textContent = sub || '';
  $('#ed-note').textContent = note || '';
  $('#ed-text').hidden = mode !== 'text';
  $('#ed-form').hidden = mode !== 'mcp';
  $('#ed-hookform').hidden = mode !== 'hook';
  $('#ed-history').hidden = mode !== 'history';
  $('#ed-delete').hidden = !canDelete;
  $('#ed-history-btn').hidden = !canHistory;
  $('#ed-save').hidden = mode === 'history' || !!editing?.readOnly;
}

async function openFileEditor(file, title, sub) {
  try {
    const r = await post('/api/file/read', { file });
    editing = { mode: 'text', file };
    showEditor({ mode: 'text', title, sub: sub || file, note: 'Saved with a copy of the original in trash/', canDelete: true, canHistory: true });
    $('#ed-text').value = r.text;
    $('#ed-text').focus();
  } catch (e) {
    toast('Cannot open that', e.message, 'bad');
  }
}

/* Hooks as a form rather than raw JSON. */
function openHookEditor(row, file) {
  editing = { mode: 'hook', file: row?.file || file, original: row || null };
  showEditor({
    mode: 'hook',
    title: row ? `Edit the ${row.event} hook` : 'New hook',
    sub: row?.file || file,
    note: 'The harness runs this itself — Claude is never asked',
    canDelete: false,
  });
  $('#ed-hook-event').value = row?.event || 'PostToolUse';
  $('#ed-hook-matcher').value = row?.matcher && row.matcher !== '*' ? row.matcher : '';
  $('#ed-hook-command').value = row?.command || '';
  $('#ed-hook-event').focus();
}

/* Every previous version of a file, from the trash the editor writes on each save. */
async function openHistory(file) {
  try {
    const res = await fetch('/api/trash');
    const { versions } = await res.json();
    const base = file.split(/[\\/]/).pop();
    const mine = versions.filter((v) => v.of === base);
    editing = { mode: 'history', file };
    showEditor({
      mode: 'history',
      title: `History of ${base}`,
      sub: mine.length ? `${mine.length} saved version${mine.length === 1 ? '' : 's'} in trash/` : file,
      note: 'Every save and delete leaves a copy here',
      canDelete: false,
    });
    const list = $('#ed-history');
    list.replaceChildren();
    if (!mine.length) {
      list.append(h('p', 'inv-empty', 'No earlier versions — this file has not been changed from here yet.'));
      return;
    }
    for (const v of mine) {
      const row = h('div', 'hist');
      row.append(h('span', 'hist-when', new Date(v.at).toLocaleString()));
      row.append(h('span', 'hist-size', kilo(v.bytes) + 'b'));
      const view = h('button', 'link', 'view');
      view.addEventListener('click', async () => {
        try {
          const r = await post('/api/trash/read', { name: v.name });
          editing = { mode: 'text', file, readOnly: true };
          showEditor({ mode: 'text', title: `${base} — ${new Date(v.at).toLocaleString()}`, sub: 'an earlier version, read only', note: 'Use restore to put this back', canDelete: false });
          $('#ed-text').value = r.text;
        } catch (e) { toast('Could not read it', e.message, 'bad'); }
      });
      const restore = h('button', 'link', 'restore');
      restore.addEventListener('click', async () => {
        if (!confirm(`Put this version back?\n\n${base} — ${new Date(v.at).toLocaleString()}\n\nThe current contents become a version too.`)) return;
        try {
          await post('/api/trash/restore', { file, name: v.name });
          toast('Restored', base, 'good');
          closeEditor();
          toolboxCacheBust();
        } catch (e) { toast('Could not restore it', e.message, 'bad'); }
      });
      row.append(view, restore);
      list.append(row);
    }
  } catch (e) {
    toast('Could not read the history', e.message, 'bad');
  }
}

async function createThing(kind, label) {
  const projects = (toolboxData?.projects || []).map((p) => p.name);
  const scopeAsk = kind === 'memory'
    ? 'project'
    : (prompt(`Where should this ${label} live?\n\nType "user" for ~/.claude, or a project name:\n${projects.join(', ')}`, 'user') || '').trim();
  if (!scopeAsk) return;
  const scope = scopeAsk === 'user' ? 'user' : 'project';
  const project = scope === 'project'
    ? (kind === 'memory' ? (prompt(`Which project?\n${projects.join(', ')}`, projects[0]) || '').trim() : scopeAsk)
    : null;
  if (scope === 'project' && !project) return;
  const name = kind === 'claudemd' ? 'CLAUDE' : (prompt(`Name for the new ${label}`, '') || '').trim();
  if (!name) return;
  try {
    const r = await post('/api/file/create', { kind, scope, project, name });
    toolboxCacheBust();
    await openFileEditor(r.file, `New ${label}`, r.file);
    toast(`${label} created`, r.file, 'good');
  } catch (e) {
    toast(`Could not create that ${label}`, e.message, 'bad');
  }
}

function toolboxCacheBust() { toolboxData = null; loadToolbox(); }

function mcpScopeOptions(selected) {
  const select = $('#ed-mcp-scope');
  select.replaceChildren();
  const user = h('option', '', 'everywhere (~/.claude.json)');
  user.value = 'user';
  select.append(user);
  for (const p of toolboxData?.projects || []) {
    const o = h('option', '', `just ${p.name} (.mcp.json)`);
    o.value = 'project:' + p.name;
    select.append(o);
  }
  select.value = selected || 'user';
}

function paintMcpTransport() {
  const kind = $('#ed-mcp-transport').value;
  for (const el of document.querySelectorAll('#ed-form .stdio-only')) el.hidden = kind !== 'stdio';
  for (const el of document.querySelectorAll('#ed-form .url-only')) el.hidden = kind === 'stdio';
}

function openMcpEditor(row) {
  const scope = row ? (row.scope === 'project' && row.projects?.[0] ? 'project:' + row.projects[0] : 'user') : 'user';
  editing = { mode: 'mcp', row: row || null, originalName: row?.name || null };
  showEditor({
    mode: 'mcp',
    title: row ? `Edit ${row.name}` : 'New MCP server',
    sub: row ? row.target : 'it will be written to the file you choose below',
    note: 'The file is backed up to trash/ before every change',
    canDelete: !!row,
  });
  mcpScopeOptions(scope);
  // Prefilled from the server's exact definition, never from the display summary - `target`
  // unwraps mcp-remote wrappers and clips long commands, so parsing it back would rewrite the
  // server as something it never was.
  const def = row?.def || { command: '', args: [], url: '', type: '', env: {} };
  const isUrl = !!def.url;
  $('#ed-mcp-name').value = row?.name || '';
  $('#ed-mcp-transport').value = isUrl ? (def.type === 'sse' ? 'sse' : 'http') : 'stdio';
  $('#ed-mcp-url').value = def.url || '';
  $('#ed-mcp-command').value = def.command || '';
  // One argument per line, so an argument containing a space survives the round trip.
  $('#ed-mcp-args').value = (def.args || []).join('\n');
  $('#ed-mcp-env').value = Object.entries(def.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  paintMcpTransport();
  $('#ed-mcp-name').focus();
}

async function saveEditor() {
  if (!editing) return;
  const btn = $('#ed-save');
  btn.disabled = true;
  try {
    if (editing.mode === 'text') {
      await post('/api/file/write', { file: editing.file, text: $('#ed-text').value });
      toast('Saved', editing.file, 'good');
    } else if (editing.mode === 'hook') {
      const prev = editing.original;
      if (prev) await post('/api/hook', { action: 'remove', file: prev.file, event: prev.event, matcher: prev.matcher, command: prev.command });
      await post('/api/hook', {
        action: 'add', file: editing.file,
        event: $('#ed-hook-event').value,
        matcher: $('#ed-hook-matcher').value,
        command: $('#ed-hook-command').value,
      });
      toast('Hook saved', 'It applies to sessions started from now on', 'good');
    } else {
      const scopeValue = $('#ed-mcp-scope').value;
      const [scope, project] = scopeValue.startsWith('project:') ? ['project', scopeValue.slice(8)] : ['user', null];
      await post('/api/mcp/save', {
        scope, project,
        name: $('#ed-mcp-name').value,
        originalName: editing.originalName,
        transport: $('#ed-mcp-transport').value,
        command: $('#ed-mcp-command').value,
        args: $('#ed-mcp-args').value,
        env: $('#ed-mcp-env').value,
        url: $('#ed-mcp-url').value,
      });
      toast('Server saved', 'Restart a Claude session for it to pick this up', 'good');
    }
    closeEditor();
    toolboxCacheBust();
  } catch (e) {
    toast('Could not save', e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function deleteEditing() {
  if (!editing) return;
  const what = editing.mode === 'text' ? editing.file : editing.originalName;
  if (!confirm(`Delete ${what}?\n\nA copy goes to the app's trash/ folder first.`)) return;
  try {
    if (editing.mode === 'text') await post('/api/file/delete', { file: editing.file });
    else {
      const scopeValue = $('#ed-mcp-scope').value;
      const [scope, project] = scopeValue.startsWith('project:') ? ['project', scopeValue.slice(8)] : ['user', null];
      await post('/api/mcp/delete', { scope, project, name: editing.originalName });
    }
    toast('Deleted', 'A copy is in trash/', 'good');
    closeEditor();
    toolboxCacheBust();
  } catch (e) {
    toast('Could not delete', e.message, 'bad');
  }
}

$('#ed-close').addEventListener('click', closeEditor);
$('#ed-cancel').addEventListener('click', closeEditor);
$('#ed-scrim').addEventListener('click', closeEditor);
$('#ed-save').addEventListener('click', saveEditor);
$('#ed-delete').addEventListener('click', deleteEditing);
$('#ed-history-btn').addEventListener('click', () => editing?.file && openHistory(editing.file));
$('#ed-mcp-transport').addEventListener('change', paintMcpTransport);
$('#ed-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); }
});

// An "edit" / "add" affordance for an inventory row.
function editLink(label, onClick) {
  const b = h('button', 'link inv-edit', label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function addButton(label, onClick) {
  const b = h('button', 'link inv-add', '+ ' + label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function invSection(name, note, rows, opts = {}) {
  const key = 'sec:' + name;
  const shut = collapsed[key] !== undefined ? !!collapsed[key] : !!opts.shutByDefault;
  const section = h('section', 'group inv-group' + (shut ? ' shut' : ''));
  const bar = h('div', 'inv-headbar');
  const head = h('button', 'group-head');
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('class', 'chev'); chev.setAttribute('viewBox', '0 0 24 24');
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', 'M9 6l6 6-6 6'); chev.append(pathEl);
  // `rows` is DOM nodes, not data - a caller rendering a single "nothing here yet" placeholder,
  // or one summary card standing in for many rules, would otherwise show a misleading count of 1.
  const count = opts.count ?? rows.length;
  head.append(chev, h('span', 'group-name', name), h('span', 'count group-count', String(count)));
  if (note) head.append(h('span', 'group-note', note));
  head.addEventListener('click', () => { collapsed[key] = !shut; store.set('collapsed', collapsed); paintToolbox(); });
  bar.append(head);
  if (opts.add) bar.append(addButton(opts.add.label, opts.add.onClick));
  const body = h('div', 'group-body inv-body');
  body.append(...rows);
  section.append(bar, body);
  return section;
}

const MCP_SCOPES = [
  ['user', 'user scope', 'in ~/.claude.json — offered in every project'],
  ['project', 'from .mcp.json', 'checked into a repo; each project opts in'],
  ['local', 'project-local', 'configured for one project only'],
  ['connector', 'claude.ai connectors', 'managed server-side — only their auth state is visible on disk'],
  ['marketplace', 'available from plugins', 'shipped by marketplace plugins — inactive unless that plugin is installed'],
];

function paintMcp() {
  const wrap = $('#mcp-list');
  wrap.replaceChildren();
  if (!toolboxData) { wrap.append(h('p', 'empty', 'reading your Claude config…')); return; }

  const usage = usageIndex('mcpUsed');
  const rows = [...(toolboxData.mcp || [])];
  const claimed = new Set();
  for (const r of rows) { const u = matchUsage(usage, r.name); if (u) claimed.add(u.key); }
  // Servers seen in transcripts that no config file mentions - claude.ai connectors, mostly.
  for (const [k, u] of usage) {
    if (claimed.has(k)) continue;
    rows.push({ name: u.label, scope: 'connector', transport: 'observed in a transcript', target: '', projects: [], enabled: true, needsAuth: false, env: [] });
  }

  const q = query.trim().toLowerCase();
  const match = (r) => !q || [r.name, r.scope, r.transport, r.target, r.plugin, ...(r.projects || [])].join(' ').toLowerCase().includes(q);

  const configured = rows.filter((r) => r.scope !== 'marketplace').length;
  $('#c-mcp').textContent = configured;
  const needing = rows.filter((r) => r.needsAuth).length;
  $('#mcp-note').innerHTML =
    `<b>${configured}</b> server${configured === 1 ? '' : 's'} configured for this machine` +
    (needing ? ` · <b class="hot">${needing} need authorising</b>` : '') +
    ` · call counts come from the recent slice of each transcript, so they show what your sessions are actually using.`;

  // The same name can legitimately sit at two scopes; say so instead of looking like a bug.
  const scopeCount = new Map();
  for (const r of rows) scopeCount.set(idKey(r.name), (scopeCount.get(idKey(r.name)) || 0) + 1);

  let any = false;
  for (const [scope, label, note] of MCP_SCOPES) {
    const mine = rows.filter((r) => r.scope === scope && match(r));
    if (!mine.length) continue;
    any = true;
    mine.sort((a, b) => a.name.localeCompare(b.name));
    wrap.append(invSection(label, note, mine.map((r) => {
      const u = matchUsage(usage, r.name);
      return invRow({
        title: r.name,
        copyText: r.name,
        badges: [
          r.needsAuth ? { text: 'needs authorising', cls: 'bad' } : null,
          !r.enabled && scope !== 'marketplace' ? { text: 'not enabled', cls: 'muted' } : null,
          r.plugin ? { text: r.plugin, cls: 'muted' } : null,
          { text: r.transport, cls: 'muted' },
          scopeCount.get(idKey(r.name)) > 1 ? { text: 'also defined elsewhere', cls: 'muted' } : null,
        ],
        target: r.target || '',
        meta: [
          r.projects?.length ? 'projects: ' + r.projects.join(', ') : '',
          r.env?.length ? 'env: ' + r.env.join(', ') : '',
        ].filter(Boolean).join('  ·  '),
        usage: u,
        file: r.file,
        // A connector is managed by claude.ai and a marketplace copy is upstream; neither is ours.
        edit: scope === 'user' || scope === 'project' || scope === 'local' ? () => openMcpEditor(r) : null,
      });
    }), {
      shutByDefault: scope === 'marketplace',
      add: scope === 'user' ? { label: 'add a server', onClick: () => openMcpEditor(null) } : null,
    }));
  }
  if (!any) {
    wrap.append(h('p', 'empty', q ? `No MCP server matches “${query}”.` : 'No MCP servers configured.'));
    wrap.append(addButton('add a server', () => openMcpEditor(null)));
  }
}

function paintTools() {
  const wrap = $('#tools-list');
  wrap.replaceChildren();
  if (!toolboxData) { wrap.append(h('p', 'empty', 'reading your Claude config…')); return; }

  const usage = usageIndex('skillsUsed');
  const counted = toolboxData.skillUsage || {};
  const q = query.trim().toLowerCase();
  const match = (r) => !q || [r.name, r.description, r.source, r.scope].join(' ').toLowerCase().includes(q);

  const skills = [...(toolboxData.skills || [])];
  const onDisk = new Set(skills.map((s) => idKey(s.name)));
  // Skills that only exist inside the CLI bundle still leave a trace in usage counts.
  for (const name of new Set([...Object.keys(counted), ...[...usage.values()].map((u) => u.label)])) {
    if (onDisk.has(idKey(name))) continue;
    skills.push({ name, description: '', scope: 'builtin', source: 'built-in', file: null });
  }

  $('#c-skills').textContent = skills.length;
  const usedCount = skills.filter((s) => usage.has(idKey(s.name)) || counted[s.name]).length;
  $('#tools-note').innerHTML =
    `<b>${skills.length}</b> skills · <b>${(toolboxData.agents || []).length}</b> agents · ` +
    `<b>${(toolboxData.commands || []).length}</b> commands · ${usedCount} skill${usedCount === 1 ? '' : 's'} you have actually run. ` +
    `Click any name to copy it.`;

  // One bucket per real source, and a single bucket for the whole marketplace - splitting it
  // per plugin buried everything else under 20 collapsed headers.
  const sourceLabel = (r) =>
    r.scope === 'user' ? 'yours (~/.claude)'
    : r.scope === 'project' ? 'project · ' + r.source
    : r.scope === 'builtin' ? 'built into Claude Code'
    : 'from marketplace plugins';

  const NOTE = {
    'built into Claude Code': 'the bundled set is inside the CLI, not on disk — only the ones you have run leave a trace',
    'from marketplace plugins': 'installed only if you have added that plugin',
  };

  const bySource = (rows, kind) => {
    const buckets = new Map();
    for (const r of rows.filter(match)) {
      const k = sourceLabel(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const rank = (x) => (x.startsWith('yours') ? 0 : x.startsWith('project') ? 1 : x.startsWith('built') ? 2 : 3);
    const order = [...buckets.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return order.map((k) => {
      const items = buckets.get(k).sort((a, b) => a.name.localeCompare(b.name));
      const slash = kind !== 'agents' ? '/' : '';
      return invSection(`${kind} · ${k}`, NOTE[k] || '', items.map((r) => {
        const u = kind === 'skills' ? matchUsage(usage, r.name) : null;
        const stat = counted[r.name];
        return invRow({
          title: slash + r.name,
          copyText: slash + r.name,
          subtitle: r.description,
          badges: [
            r.scope === 'marketplace' ? { text: r.source, cls: 'muted' } : null,
            r.model ? { text: r.model, cls: 'muted' } : null,
            stat?.usageCount ? { text: `run ${stat.usageCount}× · last ${when(stat.lastUsedAt)}`, cls: 'muted' } : null,
          ],
          usage: u,
          file: r.file,
          // Marketplace copies are upstream: an edit there dies at the next plugin update.
          edit: r.file && r.scope !== 'marketplace' ? () => openFileEditor(r.file, `Edit ${r.name}`, r.file) : null,
        });
      }), {
        shutByDefault: k === 'from marketplace plugins',
        add: k.startsWith('yours') || k.startsWith('project')
          ? { label: `new ${kind.replace(/s$/, '')}`, onClick: () => createThing(kind.replace(/s$/, ''), kind.replace(/s$/, '')) }
          : null,
      });
    });
  };

  const parts = [
    ...bySource(skills, 'skills'),
    ...bySource(toolboxData.agents || [], 'agents'),
    ...bySource(toolboxData.commands || [], 'commands'),
  ];
  if (!parts.length) wrap.append(h('p', 'empty', q ? `Nothing matches “${query}”.` : 'No skills, agents or commands found.'));
  else wrap.append(...parts);
  const newRow = h('div', 'inv-newrow');
  for (const kind of ['skill', 'agent', 'command']) newRow.append(addButton(`new ${kind}`, () => createThing(kind, kind)));
  wrap.append(newRow);
}

/* The standing instructions Claude follows here: remembered facts, CLAUDE.md files, hooks
   that fire automatically, and the permission rules you have already said yes to. */
function paintRules() {
  const wrap = $('#rules-list');
  wrap.replaceChildren();
  if (!toolboxData) { wrap.append(h('p', 'empty', 'reading your Claude config…')); return; }

  const r = toolboxData.rules || { memory: [], claudeMd: [], hooks: [], permissions: [] };
  const q = query.trim().toLowerCase();
  const hit = (...parts) => !q || parts.filter(Boolean).join(' ').toLowerCase().includes(q);

  $('#c-rules').textContent = r.memory.length + r.claudeMd.length + r.hooks.length;
  $('#rules-note').innerHTML =
    `<b>${r.memory.length}</b> remembered facts · <b>${r.claudeMd.length}</b> CLAUDE.md file${r.claudeMd.length === 1 ? '' : 's'} · ` +
    `<b>${r.hooks.length}</b> hook${r.hooks.length === 1 ? '' : 's'} · <b>${r.permissions.length}</b> permission rules. ` +
    `Everything Claude reads before it starts, in the order it takes effect. Click a name to open the file.`;

  const parts = [];

  // Memory, grouped by the project it belongs to, index card first.
  const byProject = new Map();
  for (const m of r.memory.filter((m) => hit(m.name, m.description, m.preview, m.kind))) {
    if (!byProject.has(m.project)) byProject.set(m.project, []);
    byProject.get(m.project).push(m);
  }
  for (const [project, items] of [...byProject].sort((a, b) => b[1].length - a[1].length)) {
    items.sort((a, b) => (b.isIndex ? 1 : 0) - (a.isIndex ? 1 : 0) || a.name.localeCompare(b.name));
    parts.push(invSection(`memory · ${project}`, 'facts carried into every session in this project', items.map((m) => invRow({
      title: m.name,
      copyText: m.name,
      subtitle: m.description || m.preview,
      badges: [m.isIndex ? { text: 'index', cls: 'muted' } : m.kind ? { text: m.kind, cls: 'muted' } : null],
      meta: m.description && m.preview ? m.preview : '',
      file: m.file,
      edit: () => openFileEditor(m.file, `Edit ${m.name}`, m.file),
      history: () => openHistory(m.file),
    })), { add: { label: 'new memory', onClick: () => createThing('memory', 'memory') } }));
  }

  const md = r.claudeMd.filter((m) => hit(m.name, m.source, m.preview, m.file));
  if (md.length) {
    parts.push(invSection('CLAUDE.md', 'project and personal instruction files', md.map((m) => invRow({
      title: m.scope === 'user' ? '~/.claude/CLAUDE.md' : `${m.source} / ${m.name}`,
      subtitle: m.preview,
      badges: [{ text: m.scope === 'user' ? 'personal' : 'project', cls: 'muted' }, { text: kilo(m.bytes) + 'b', cls: 'muted' }],
      file: m.file,
      edit: () => openFileEditor(m.file, `Edit ${m.source}/${m.name}`, m.file),
    })), { add: { label: 'new CLAUDE.md', onClick: () => createThing('claudemd', 'CLAUDE.md') } }));
  }

  const hooks = r.hooks.filter((x) => hit(x.event, x.matcher, x.command, x.source));
  const settingsFiles = [...new Set(r.permissions.map((x) => x.file))];
  const hookHome = settingsFiles[0] || (toolboxData.dirs?.claude && toolboxData.dirs.claude + '\\settings.json');
  parts.push(invSection('hooks', 'commands the harness runs for you, without asking Claude',
    hooks.length ? hooks.map((x) => invRow({
      title: x.event,
      subtitle: x.command,
      badges: [{ text: 'on ' + (x.matcher || '*'), cls: 'muted' }, { text: x.source, cls: 'muted' }],
      file: x.file,
      edit: () => openHookEditor(x),
      remove: async () => {
        if (!confirm(`Remove this ${x.event} hook?\n\n${x.command}`)) return;
        try {
          await post('/api/hook', { action: 'remove', file: x.file, event: x.event, matcher: x.matcher, command: x.command });
          toast('Hook removed', x.event, 'good');
          toolboxCacheBust();
        } catch (err) { toast('Could not remove it', err.message, 'bad'); }
      },
    })) : [h('p', 'inv-empty', 'No hooks configured. A hook makes something happen every time — a formatter after each edit, a notification when a session stops.')],
    { count: hooks.length, add: hookHome ? { label: 'new hook', onClick: () => openHookEditor(null, hookHome) } : null }));

  // 88 permission rules deserve a compact list, not 88 cards.
  const byOwner = new Map();
  for (const p of r.permissions.filter((p) => hit(p.rule, p.source, p.kind))) {
    const k = p.source;
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(p);
  }
  for (const [owner, items] of [...byOwner].sort((a, b) => b[1].length - a[1].length)) {
    const card = h('article', 'inv rules-perms');
    const head = h('div', 'inv-head');
    head.append(h('span', 'inv-name', owner));
    for (const kind of ['allow', 'ask', 'deny']) {
      const n = items.filter((x) => x.kind === kind).length;
      if (n) head.append(h('span', 'badge ' + (kind === 'deny' ? 'bad' : 'muted'), `${n} ${kind}`));
    }
    card.append(head);
    const file = items[0].file;
    const list = h('div', 'perm-list');
    for (const p of items) {
      const chip = h('code', 'perm ' + p.kind);
      chip.append(h('span', '', p.rule));
      // Removing a rule narrows what Claude may do unasked, so it needs no ceremony beyond a confirm.
      const kill = h('button', 'perm-x', '×');
      kill.title = `Remove this ${p.kind} rule`;
      kill.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove this ${p.kind} rule?\n\n${p.rule}\n\nThe file is backed up to trash/ first.`)) return;
        try {
          await post('/api/permission', { action: 'remove', file, kind: p.kind, rule: p.rule });
          toast('Rule removed', p.rule, 'good');
          toolboxCacheBust();
        } catch (err) { toast('Could not remove it', err.message, 'bad'); }
      });
      chip.append(kill);
      list.append(chip);
    }
    card.append(list);

    const tools = h('div', 'inv-tools');
    for (const kind of ['allow', 'deny']) {
      tools.append(editLink(`+ ${kind} rule`, async () => {
        const rule = (prompt(`New ${kind} rule for ${owner}\n\nExamples:  Bash(npm test:*)   Edit   WebFetch(domain:github.com)`, '') || '').trim();
        if (!rule) return;
        if (kind === 'allow' && !confirm(`Allow this without asking, from now on?\n\n${rule}`)) return;
        try {
          await post('/api/permission', { action: 'add', file, kind, rule });
          toast(`Added to ${kind}`, rule, 'good');
          toolboxCacheBust();
        } catch (err) { toast('Could not add it', err.message, 'bad'); }
      }));
    }
    const open = h('button', 'link', 'open ' + file.split(/[\\/]/).pop());
    open.title = file;
    open.addEventListener('click', () => act('/api/open', { target: 'file', file }, 'Opening…'));
    tools.append(open);
    card.append(tools);
    parts.push(invSection(`permissions · ${owner}`, `${items.length} rules you have already approved`, [card], { count: items.length, shutByDefault: true }));
  }

  if (!parts.length) wrap.append(h('p', 'empty', q ? `Nothing matches “${query}”.` : 'No rules found.'));
  else wrap.append(...parts);
}
