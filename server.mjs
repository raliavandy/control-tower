#!/usr/bin/env node
// Rals Cockpit - a local control screen for every Claude Code session on this machine.
// Zero dependencies. Reads ~/.claude, serves a UI on 127.0.0.1, never talks to the network.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  configureOpenAI, openaiHas, openaiSessions, openaiReadConversation, openaiDelete, openaiUnpin,
  runOpenAIChat, testOpenAIKey, OPENAI_MODELS, openaiUsageEntries,
} from './server/providers/openai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PUBLIC_DIR = path.join(HERE, 'public');
configureOpenAI(HERE);

const PORT = Number(process.env.FLEET_PORT || 7457);
const TOKEN = crypto.randomBytes(16).toString('hex');

/* Phone access is opt-in and never silent: without FLEET_LAN the server keeps binding to
   loopback only. With it, anything off this machine must present an access code first -
   this UI can open terminals, so an unauthenticated LAN port would be a real hole. */
const LAN = process.env.FLEET_LAN === '1' || process.env.FLEET_LAN === 'true';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const ACCESS = (process.env.FLEET_KEY || '').trim() ||
  Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;
const POLL_MS = Number(process.env.FLEET_POLL_MS || 2000);
const HISTORY_LIMIT = Number(process.env.FLEET_HISTORY || 60);

const TAIL_BYTES = 256 * 1024;      // normal tail read per transcript
const BIG_TAIL_BYTES = 3 * 1024 * 1024; // retry when base64 attachments swallow the tail
const HEAD_BYTES = 96 * 1024;       // for first-prompt fallback titles
const IDLE_AFTER_MS = 2 * 60 * 60 * 1000;

// A pending tool call with no transcript writes for this long reads as "waiting on you".
// Tuned per tool: an Edit that sits for 12s is almost certainly a permission prompt, while
// Bash and subagents legitimately run for minutes.
const STALL_MS = { default: 25_000, slow: 120_000, quick: 12_000 };
const SLOW_TOOLS = new Set(['Bash', 'PowerShell', 'Agent', 'Task', 'Workflow', 'WebFetch', 'WebSearch', 'Monitor', 'Artifact']);
const QUICK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const stallMs = (toolName) => {
  const n = toolName || '';
  if (QUICK_TOOLS.has(n)) return STALL_MS.quick;
  if (SLOW_TOOLS.has(n) || n.includes(':')) return STALL_MS.slow; // ':' = an MCP call
  return STALL_MS.default;
};

// ---------------------------------------------------------------- small helpers

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s || '');

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTailLines(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const text = readSlice(file, start, size - start);
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // first line is probably a fragment
  return lines;
}

function parseJsonLines(lines) {
  const rows = [];
  for (const line of lines) {
    if (line.length < 2 || line[0] !== '{') continue;
    try { rows.push(JSON.parse(line)); } catch { /* truncated or oversized line */ }
  }
  return rows;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// mcp__claude_ai_Asana__get_task -> "claude.ai Asana" (the server, not the tool)
function mcpServerOf(name) {
  const m = /^mcp__(.+?)__/.exec(name || '');
  if (!m) return null;
  return m[1].replace(/^claude_ai_/, 'claude.ai ').replace(/_/g, ' ').trim();
}

// mcp__claude_ai_Asana__get_task -> Asana:get_task
function prettyTool(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  if (!m) return name || 'tool';
  const server = m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ').trim();
  return `${server}:${m[2]}`;
}

// Describe what a tool call is actually doing, for the "current activity" line.
function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  const base = (p) => String(p).split(/[\\/]/).pop();
  if (input.file_path) return base(input.file_path);
  if (input.notebook_path) return base(input.notebook_path);
  if (input.command) return clip(String(input.command).replace(/\s+/g, ' ').trim(), 70);
  if (input.pattern) return clip(input.pattern, 50) + (input.path ? ` in ${base(input.path)}` : '');
  if (input.url) return clip(input.url, 60);
  if (input.query) return clip(input.query, 60);
  if (input.description) return clip(input.description, 60);
  if (input.prompt) return clip(String(input.prompt).replace(/\s+/g, ' ').trim(), 60);
  if (input.skill) return input.skill;
  return '';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
}

function isToolResultOnly(content) {
  return Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === 'tool_result');
}

// A user row that is a real human prompt, not a tool result or an injected reminder.
function isHumanPrompt(row) {
  if (row.type !== 'user' || row.isSidechain || row.isMeta) return false;
  const c = row.message?.content;
  if (isToolResultOnly(c)) return false;
  const t = textOf(c).trim();
  if (!t && !Array.isArray(c)) return false;
  if (t.startsWith('<command-name>') || t.startsWith('<local-command')) return false;
  if (t.startsWith('Caveat: The messages below')) return false;
  return true;
}

// ---------------------------------------------------------------- transcript digest

const digestCache = new Map(); // file -> { mtimeMs, size, digest }

function digestTranscript(file, stat) {
  const hit = digestCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.digest;

  let rows = parseJsonLines(readTailLines(file, stat.size, TAIL_BYTES));
  if (rows.length < 4 && stat.size > TAIL_BYTES) {
    rows = parseJsonLines(readTailLines(file, stat.size, BIG_TAIL_BYTES));
  }

  const d = {
    title: null, lastPrompt: null, model: null, effort: null, permissionMode: null,
    version: null, gitBranch: null, cwd: null, entrypoint: null, promptSource: null,
    lastActivity: 0, lastRole: null, lastText: '', promptCount: 0, turnCount: 0,
    pendingTool: null, subagentsRunning: 0, queued: 0, tokens: null, windowTruncated: rows.length < 4,
    mcpUsed: {}, skillsUsed: {},
  };

  const toolUses = new Map(); // id -> { name, input, ts, sidechain }
  const toolResults = new Set();
  let enq = 0, gone = 0; // queue ops: enqueue vs (dequeue | remove)
  let lastMain = null;

  for (const row of rows) {
    const ts = row.timestamp ? Date.parse(row.timestamp) : 0;
    if (ts) d.lastActivity = Math.max(d.lastActivity, ts);
    if (row.aiTitle) d.title = row.aiTitle;
    if (row.lastPrompt) d.lastPrompt = row.lastPrompt;
    if (row.gitBranch) d.gitBranch = row.gitBranch;
    if (row.cwd) d.cwd = row.cwd;
    if (row.version) d.version = row.version;
    if (row.effort) d.effort = row.effort;
    if (row.permissionMode) d.permissionMode = row.permissionMode;
    if (row.entrypoint) d.entrypoint = row.entrypoint;
    if (row.promptSource) d.promptSource = row.promptSource;
    if (row.type === 'queue-operation') { if (row.operation === 'enqueue') enq++; else gone++; }

    const msg = row.message;
    if (row.type === 'assistant' && msg) {
      if (msg.model) d.model = msg.model;
      if (msg.usage) {
        const u = msg.usage;
        d.tokens = {
          context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          output: (d.tokens?.output || 0) + (u.output_tokens || 0),
        };
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_use') continue;
        toolUses.set(b.id, { name: b.name, input: b.input, ts, sidechain: !!row.isSidechain });
        // Which MCP servers and skills this session actually reached for, in this window.
        const server = mcpServerOf(b.name);
        if (server) d.mcpUsed[server] = (d.mcpUsed[server] || 0) + 1;
        else if (b.name === 'Skill' && b.input?.skill) {
          const k = String(b.input.skill).trim();
          if (k) d.skillsUsed[k] = (d.skillsUsed[k] || 0) + 1;
        }
      }
      if (!row.isSidechain) { d.turnCount++; lastMain = row; }
    } else if (row.type === 'user' && msg) {
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type === 'tool_result') toolResults.add(b.tool_use_id);
      }
      if (!row.isSidechain) {
        if (isHumanPrompt(row)) d.promptCount++;
        lastMain = row;
      }
    }
  }

  d.queued = Math.max(0, enq - gone);

  if (lastMain) {
    d.lastRole = lastMain.type;
    d.lastText = clip(textOf(lastMain.message?.content).trim(), 600);
    if (!d.lastActivity && lastMain.timestamp) d.lastActivity = Date.parse(lastMain.timestamp);
  }

  // Outstanding tool calls: the strongest signal for "running" vs "asking you".
  let newest = null;
  for (const [id, use] of toolUses) {
    if (toolResults.has(id)) continue;
    if (use.sidechain) continue;
    if (!newest || use.ts >= newest.ts) newest = use;
  }
  if (newest) d.pendingTool = { name: prettyTool(newest.name), target: toolTarget(newest.name, newest.input), since: newest.ts };
  for (const [id, use] of toolUses) {
    if (!toolResults.has(id) && (use.name === 'Agent' || use.name === 'Task' || use.name === 'Workflow')) d.subagentsRunning++;
  }

  // Fall back to the opening prompt when the session never got an AI title.
  if (!d.title) {
    const headRows = parseJsonLines(readSlice(file, 0, Math.min(HEAD_BYTES, stat.size)).split('\n'));
    for (const row of headRows) {
      if (row.aiTitle) { d.title = row.aiTitle; break; }
      if (isHumanPrompt(row)) {
        const t = textOf(row.message?.content).replace(/\s+/g, ' ').trim();
        if (t) { d.title = clip(t, 70); break; }
      }
    }
  }

  digestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest: d });
  return d;
}

// ---------------------------------------------------------------- discovery

function liveProcesses() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (!rec.sessionId || !pidAlive(rec.pid)) continue;
      out.push(rec);
    } catch { /* half-written file */ }
  }
  return out;
}

function transcriptIndex() {
  const map = new Map(); // sessionId -> { file, stat, projectSlug }
  let slugs = [];
  try { slugs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return map; }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, slug.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      if (stat.size < 2) continue;
      const id = e.name.replace(/\.jsonl$/, '');
      const prev = map.get(id);
      if (!prev || stat.mtimeMs > prev.stat.mtimeMs) map.set(id, { file, stat, projectSlug: slug.name });
    }
  }
  return map;
}

function projectName(cwd, slug) {
  if (cwd) {
    const parts = String(cwd).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }
  return (slug || '').split('-').filter(Boolean).pop() || 'unknown';
}

/* "Claude just handed back to you" and "Claude finished an hour ago and you moved on" are the
   same shape in a transcript, and calling both of them "waiting for you" made three long-finished
   chats sit in the attention queue shouting for a reply. So the hand-back decays: amber only
   while you are plausibly still in the loop, then it settles into `done`. */
const HANDBACK_MS = Number(process.env.FLEET_HANDBACK_MS || 10 * 60 * 1000);

/* A long tool call and a permission prompt look identical in a transcript, and treating them the
   same meant a `npm run build` or a five-minute test run was announced as "needs you".
   Two things separate them well enough:
     - what the tool is. Bash, PowerShell, subagents and MCP calls legitimately run for minutes,
       so their patience is much longer and they report "still running" rather than crying wolf.
     - whether the session prompts at all. Under auto or acceptEdits or bypassPermissions there is
       no prompt to be waiting on, so a pending call there is always work in progress. */
const LONG_AFTER_MS = Number(process.env.FLEET_LONG_MS || 12 * 60 * 1000);
const NO_PROMPT_MODES = new Set(['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']);

/* Where a chat came from. Claude Code stamps every transcript row with an entrypoint, and a chat
   this app started is recorded in chats.json - so "is this a terminal, the desktop app, VS Code or
   something I opened here?" is answerable rather than guessable. */
function originOf(entrypoint, promptSource, inPage) {
  const e = String(entrypoint || '').toLowerCase();
  if (e.includes('vscode') || e.includes('vs-code')) return { key: 'vscode', label: 'VS Code' };
  if (e.includes('desktop')) return { key: 'desktop', label: 'Claude app' };
  if (e.includes('web')) return { key: 'web', label: 'claude.ai' };
  if (e === 'cli' || e.startsWith('cli')) return { key: 'terminal', label: 'terminal' };
  // A headless turn is how this app talks to Claude, so an sdk-only transcript began here.
  if (inPage || promptSource === 'sdk' || e === 'sdk') return { key: 'page', label: 'this page' };
  if (e) return { key: 'other', label: e };
  return { key: 'unknown', label: 'unknown' };
}

function statusOf(d, alive, lastActivity, now) {
  if (!alive) return 'ended';
  const silent = now - lastActivity;
  if (d.pendingTool) {
    const name = d.pendingTool.name || '';
    if (silent <= stallMs(name)) return 'working';
    const slow = SLOW_TOOLS.has(name) || name.includes(':');
    if (slow) return silent > LONG_AFTER_MS ? 'blocked' : 'long';
    if (NO_PROMPT_MODES.has(d.permissionMode)) return 'long';
    return 'blocked';
  }
  if (d.lastRole === 'user') return silent > 90_000 ? 'waiting-for-you' : 'working';
  if (silent > IDLE_AFTER_MS) return 'idle';
  return silent > HANDBACK_MS ? 'done' : 'waiting-for-you';
}

/* ------------------------------------------------------------- marked idle by hand

   Inference cannot tell "Claude is waiting for an answer" apart from "you read it and you
   are done with it" - both look like a finished turn, so a chat you have mentally closed
   keeps its place in the attention queue for two hours. Marking it idle says so out loud.

   The mark deliberately does not stick: it remembers nothing but the moment it was made, and
   the first transcript write after that retires it, so a session can never be silenced for
   longer than it stays quiet. This lives on the server rather than in localStorage because
   the queue, the ranks and the header counts are all computed here - and the phone should
   see the same board as the desktop. */

const IDLE_MARKS_FILE = path.join(HERE, 'idle-marks.json');

const idleMarks = (() => {
  const map = new Map(); // sessionId -> ms the mark was made at
  const raw = readJson(IDLE_MARKS_FILE);
  if (raw && typeof raw === 'object') {
    for (const [id, at] of Object.entries(raw)) if (Number.isFinite(at)) map.set(id, at);
  }
  return map;
})();

function saveIdleMarks() {
  try { fs.writeFileSync(IDLE_MARKS_FILE, JSON.stringify(Object.fromEntries(idleMarks), null, 2)); }
  catch { /* a lost mark is not worth taking the server down for */ }
}

function idleMarked(id, lastActivity) {
  const at = idleMarks.get(id);
  if (at === undefined) return false;
  if (lastActivity > at) { idleMarks.delete(id); saveIdleMarks(); return false; }
  return true;
}

// Claude Code's own session discovery: live PID files plus on-disk transcripts. This is the
// first entry in the PROVIDERS registry (below) - a second provider just needs its own
// `<name>Sessions(now)` returning the same session shape, tagged with its own `provider` value.
function claudeSessions(now) {
  const index = transcriptIndex();
  const live = liveProcesses();
  const seen = new Set();
  const sessions = [];

  const push = (id, proc, entry) => {
    if (seen.has(id)) return;
    seen.add(id);
    const alive = !!proc;
    const d = entry ? digestTranscript(entry.file, entry.stat) : null;
    const mtime = entry ? entry.stat.mtimeMs : (proc?.startedAt || 0);
    const lastActivity = Math.max(mtime, d?.lastActivity || 0);
    const cwd = proc?.cwd || d?.cwd || '';
    // Only live chats can be marked: an ended one is already out of the queue.
    const marked = alive && idleMarked(id, lastActivity);
    // A chat you held in this page has no process, but it is not "ended" either - it is right
    // here and resumable, so it gets its own status instead of sinking into history.
    const inPage = inPageChats.has(id);
    const status = marked ? 'idle'
      : !alive && inPage ? 'here'
      : statusOf(d || {}, alive, lastActivity, now);
    sessions.push({
      id,
      provider: 'claude',
      alive,
      pid: proc?.pid || null,
      procName: proc?.name || null,
      entrypoint: proc?.entrypoint || d?.entrypoint || null,
      kind: proc?.kind || null,
      startedAt: proc?.startedAt || null,
      title: d?.title || proc?.name || id.slice(0, 8),
      lastPrompt: d?.lastPrompt || '',
      lastRole: d?.lastRole || null,
      lastText: d?.lastText || '',
      status,
      idleMarked: marked,
      inPage,
      inPageTurns: inPageChats.get(id)?.turns || 0,
      origin: originOf(proc?.entrypoint || d?.entrypoint, d?.promptSource, inPage),
      spend: perSession.get(id) || null,
      needsYou: status === 'blocked' || status === 'waiting-for-you',
      rank: null, // 1 = attend to this one first; filled in below
      mcpUsed: d?.mcpUsed || {},
      skillsUsed: d?.skillsUsed || {},
      pendingTool: d?.pendingTool || null,
      subagentsRunning: d?.subagentsRunning || 0,
      queued: d?.queued || 0,
      promptCount: d?.promptCount || 0,
      turnCount: d?.turnCount || 0,
      tokens: d?.tokens || null,
      model: d?.model || null,
      effort: d?.effort || null,
      permissionMode: d?.permissionMode || null,
      version: proc?.version || d?.version || null,
      gitBranch: d?.gitBranch || null,
      cwd,
      project: projectName(cwd, entry?.projectSlug),
      transcript: entry?.file || null,
      lastActivity,
      sizeBytes: entry?.stat.size || 0,
      truncatedWindow: !!d?.windowTruncated,
    });
  };

  for (const proc of live) push(proc.sessionId, proc, index.get(proc.sessionId));

  // Chats held in this page come before the history slice, so they are never the ones that
  // fall off the end of it.
  for (const chat of [...inPageChats.values()].sort((a, b) => b.lastAt - a.lastAt)) {
    if (index.has(chat.id)) push(chat.id, null, index.get(chat.id));
  }

  const history = [...index.entries()]
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => b[1].stat.mtimeMs - a[1].stat.mtimeMs)
    .slice(0, HISTORY_LIMIT);
  for (const [id, entry] of history) push(id, null, entry);

  return sessions;
}

function buildState() {
  const now = Date.now();
  const sessions = [...claudeSessions(now), ...openaiSessions(now)];

  // Claude's own collector already resolves idle-marking itself (idleMarked() is called once
  // inline per session, since a chat's own lastActivity clears its own mark). Other providers
  // don't touch that shared map, so it's applied uniformly here instead of duplicating the
  // marking logic per provider.
  for (const s of sessions) {
    if (s.provider === 'claude') continue;
    if (idleMarked(s.id, s.lastActivity)) { s.status = 'idle'; s.idleMarked = true; s.needsYou = false; }
  }

  // Who to attend to first: a stalled tool call (someone is staring at a prompt) outranks a
  // finished turn, and within each band the one that has been waiting longest wins.
  const liveOnes = sessions.filter((s) => s.alive);

  // A mark says "done with this one for now"; once a session is actually gone there is nothing
  // left to quieten, so the mark goes with it. "Gone" means ended for Claude (its process died
  // and it isn't held open in this page) - an OpenAI chat is never "alive" between turns the way
  // a Claude terminal is, so gating this on `alive` would drop its mark after every single turn.
  if (idleMarks.size) {
    const keepIds = new Set(sessions.filter((s) => s.status !== 'ended').map((s) => s.id));
    let dropped = false;
    for (const id of [...idleMarks.keys()]) if (!keepIds.has(id)) { idleMarks.delete(id); dropped = true; }
    if (dropped) saveIdleMarks();
  }

  const queue = liveOnes
    .filter((s) => s.needsYou)
    .sort((a, b) => (a.status === 'blocked' ? 0 : 1) - (b.status === 'blocked' ? 0 : 1) || a.lastActivity - b.lastActivity);
  queue.forEach((s, i) => { s.rank = i + 1; });

  // Running sessions first, then the chats living in this page, then history.
  const onDeck = (s) => (s.alive ? 0 : s.status === 'here' ? 1 : 2);
  sessions.sort((a, b) => {
    if (onDeck(a) !== onDeck(b)) return onDeck(a) - onDeck(b);
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
    if (a.rank && b.rank) return a.rank - b.rank;
    return b.lastActivity - a.lastActivity;
  });

  return {
    generatedAt: now,
    pollMs: POLL_MS,
    claudeDir: CLAUDE_DIR,
    host: os.hostname(),
    stats: {
      live: liveOnes.length,
      needsYou: queue.length,
      working: liveOnes.filter((s) => s.status === 'working').length,
      blocked: liveOnes.filter((s) => s.status === 'blocked').length,
      here: sessions.filter((s) => s.status === 'here').length,
      history: sessions.length - liveOnes.length,
      firstUp: queue[0]?.id || null,
    },
    sessions,
  };
}

// ---------------------------------------------------------------- transcript view

// Images live in the transcript as base64. Inlining them into the conversation payload would
// mean multi-megabyte JSON, so each one keeps a reference and /api/image serves it on demand.
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const imageRefs = (row, blocks) => blocks
  .map((b, i) => ({ b, i }))
  .filter(({ b }) => b?.type === 'image' && b.source?.type === 'base64' && IMAGE_MIME.has(b.source.media_type))
  .map(({ b, i }) => ({ uuid: row.uuid, b: i, mediaType: b.source.media_type }));

// A row uuid is stable, so it stays valid however much the file grows after this.
function findRow(file, size, uuid) {
  const scan = (bytes) => {
    for (const row of parseJsonLines(readTailLines(file, size, bytes))) {
      if (row.uuid === uuid) return row;
    }
    return null;
  };
  return scan(BIG_TAIL_BYTES) || (size <= 96 * 1024 * 1024 ? scan(size) : null);
}

// Dispatches by provider before doing any real work: an OpenAI id never appears in Claude's own
// transcript index, so this only needs to ask "do we have an OpenAI chat by this id" first.
function readConversation(id, limit = 60) {
  if (openaiHas(id)) return openaiReadConversation(id, limit);
  return claudeReadConversation(id, limit);
}

function claudeReadConversation(id, limit = 60) {
  const entry = transcriptIndex().get(id);
  if (!entry) return null;
  const rows = parseJsonLines(readTailLines(entry.file, entry.stat.size, BIG_TAIL_BYTES));
  const items = [];
  for (const row of rows) {
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const msg = row.message;
    if (!msg) continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = textOf(msg.content).trim();
    const tools = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ name: prettyTool(b.name), target: toolTarget(b.name, b.input) }));
    const results = blocks.filter((b) => b?.type === 'tool_result').length;
    const images = imageRefs(row, blocks);
    if (!text && !tools.length && !results && !images.length) continue;
    // Tool-result-only turns are pure plumbing - the assistant's tool chips already say what ran.
    if (row.type === 'user' && !text && !tools.length && !images.length) continue;
    items.push({
      role: row.type,
      sidechain: !!row.isSidechain,
      ts: row.timestamp || null,
      text: clip(text, 4000),
      tools,
      results,
      images,
      isToolTurn: !text && (results > 0 || tools.length > 0),
    });
  }
  // One assistant turn shows up as several rows (text, then a row per tool call).
  // Fold the text-less ones back into the turn they belong to.
  const merged = [];
  for (const it of items) {
    const prev = merged[merged.length - 1];
    if (prev && it.role === 'assistant' && prev.role === 'assistant' && !it.text && prev.sidechain === it.sidechain) {
      prev.tools.push(...it.tools);
      prev.images.push(...it.images);
      prev.results += it.results;
      prev.ts = it.ts || prev.ts;
      continue;
    }
    merged.push({ ...it, tools: [...it.tools], images: [...it.images] });
  }
  const kept = merged.slice(-limit);
  return { id, title: digestTranscript(entry.file, entry.stat).title, total: items.length, items: kept, file: entry.file };
}

// ---------------------------------------------------------------- usage

/* ~/.claude/stats-cache.json only refreshes when the CLI recomputes it, so it can be months
   stale. The transcripts carry the real thing: every assistant row has a `usage` block. A full
   pass over ~100 MB takes about half a second, and each file's entries are cached on
   (mtime, size), so only a live session gets re-read.

   Forked and resumed sessions replay earlier messages into new files - on this machine that is
   6400 of 11500 rows - so entries are keyed by the API message id and counted once. */

const usageCache = new Map(); // file -> { mtimeMs, size, entries: Map }
// Filled the first time usage is aggregated; the board reads cost per session out of it rather
// than triggering a 100 MB scan of its own on the very first paint.
let perSession = new Map();

function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function usageEntries(file, stat) {
  const hit = usageCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.entries;

  const entries = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* vanished mid-scan */ }
  let n = 0, dupes = 0;
  for (const line of text.split('\n')) {
    n++;
    if (line.length < 2 || line[0] !== '{') continue;
    if (!line.includes('"usage"')) continue; // cheap pre-filter: most rows have none
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const u = row.message?.usage;
    if (row.type !== 'assistant' || !u) continue;
    const model = row.message.model || 'unknown';
    if (model === '<synthetic>') continue; // not a real request
    const key = row.message.id || `${file}#${n}`;
    if (entries.has(key)) dupes++;   // the same message replayed further down this same file
    entries.set(key, {
      day: localDay(row.timestamp),
      model,
      sidechain: !!row.isSidechain,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
      // Claude Code stamps the running cost on the row; it is the only cost figure on disk.
      cost: typeof row.costUSD === 'number' ? row.costUSD
        : typeof row.totalCostUsd === 'number' ? row.totalCostUsd : 0,
    });
  }
  usageCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries, dupes });
  return entries;
}

const dupesIn = (file) => usageCache.get(file)?.dupes || 0;

const zero = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 });

function bump(map, key, e) {
  const t = map.get(key) || zero();
  t.requests++;
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheCreate += e.cacheCreate;
  t.cost += e.cost || 0;
  map.set(key, t);
}

function buildUsage() {
  const bySlug = dirsBySlug();
  const days = new Map(), models = new Map(), projects = new Map(), sessions = new Map();
  const totals = zero();
  const counted = new Set();
  let subagentRequests = 0;
  let duplicatesSkipped = 0;

  let slugs = [];
  try { slugs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { /* no projects yet */ }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const known = bySlug.get(slug.name.toLowerCase());
    const project = known ? leaf(known) : (slug.name.split('-').filter(Boolean).pop() || slug.name);
    const dir = path.join(PROJECTS_DIR, slug.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      const fileEntries = usageEntries(file, stat);
      const sessionId = f.replace(/\.jsonl$/i, '');
      duplicatesSkipped += dupesIn(file);
      for (const [id, e] of fileEntries) {
        if (counted.has(id)) { duplicatesSkipped++; continue; } // replayed into a forked transcript
        counted.add(id);
        bump(days, e.day, e);
        bump(models, e.model, e);
        bump(projects, project, e);
        bump(sessions, sessionId, e);
        totals.requests++;
        totals.input += e.input;
        totals.output += e.output;
        totals.cacheRead += e.cacheRead;
        totals.cacheCreate += e.cacheCreate;
        totals.cost += e.cost || 0;
        if (e.sidechain) subagentRequests++;
      }
    }
  }

  // OpenAI has no on-disk cache-hit concept and no forked-transcript replay to dedupe, so its
  // entries fold straight into the same day/model/project buckets Claude's own entries use -
  // the whole point of a shared entry shape is that the view above doesn't need to know or care
  // which provider a given bar or ranking came from.
  for (const e of openaiUsageEntries()) {
    bump(days, e.day, e);
    bump(models, e.model, e);
    bump(projects, e.project, e);
    bump(sessions, e.sessionId, e);
    totals.requests++;
    totals.input += e.input;
    totals.output += e.output;
    totals.cacheRead += e.cacheRead;
    totals.cacheCreate += e.cacheCreate;
    totals.cost += e.cost || 0;
  }

  const rows = (map, key) => [...map].map(([k, v]) => ({ [key]: k, ...v }));
  // Kept as a map for buildState to look a single session up in.
  perSession = sessions;
  return {
    generatedAt: Date.now(),
    today: localDay(Date.now()),
    totals,
    subagentRequests,
    duplicatesSkipped,
    days: rows(days, 'date').filter((d) => d.date !== 'unknown').sort((a, b) => a.date.localeCompare(b.date)),
    models: rows(models, 'model').sort((a, b) => b.output - a.output),
    projects: rows(projects, 'project').sort((a, b) => b.output - a.output),
    // Not on disk anywhere - the API volunteers it on each headless turn, so it only appears
    // once you have used the in-page chat at least once this run.
    rateLimit: lastRateLimit,
    statsCache: (() => {
      const s = readJson(path.join(CLAUDE_DIR, 'stats-cache.json'));
      return s ? { lastComputedDate: s.lastComputedDate || null, totalSessions: s.totalSessions || 0 } : null;
    })(),
  };
}

let usageAggregate = { at: 0, data: null };

function usage() {
  const now = Date.now();
  if (usageAggregate.data && now - usageAggregate.at < 15_000) {
    return { ...usageAggregate.data, rateLimit: lastRateLimit };
  }
  const data = buildUsage();
  usageAggregate = { at: now, data };
  return data;
}

// ------------------------------------------------- toolbox: mcp / skills / agents / commands

const CLAUDE_JSON = path.join(HOME, '.claude.json');
const MCP_AUTH_CACHE = path.join(CLAUDE_DIR, 'mcp-needs-auth-cache.json');
const MARKETS_DIR = path.join(CLAUDE_DIR, 'plugins', 'marketplaces');
const TOOLBOX_TTL = 10_000;

// JSON.parse keeps the last of duplicated keys, which matters: ~/.claude.json really does
// carry both "c:/Users/..." and "C:/Users/..." entries for the same project.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Enough YAML for SKILL.md / agent frontmatter: scalars plus folded continuation lines.
function frontmatter(file) {
  let head = '';
  try { head = readSlice(file, 0, 8192); } catch { return {}; }
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (kv) { key = kv[1]; out[key] = kv[2].trim().replace(/^["']|["']$/g, '').replace(/^[|>][-+]?$/, ''); }
    else if (key && /^\s+\S/.test(raw)) out[key] = ((out[key] || '') + ' ' + raw.trim()).trim();
  }
  return out;
}

// `root` itself may be a dotted directory (.claude/skills); its descendants may not be, so
// scanning a whole repo for CLAUDE.md never wanders into .git or a build output.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'out', 'build', 'vendor', 'tmp']);

function findFiles(root, match, depth = 2) {
  const out = [];
  const walk = (dir, d) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) { if (match.test(e.name)) out.push(full); }
      else if (e.isDirectory() && d < depth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, d + 1);
    }
  };
  walk(root, 0);
  return out;
}

const idKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const leaf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

// Every project Claude Code has been run in, de-duplicated across the case-variant twins.
function projectEntries() {
  const cfg = readJson(CLAUDE_JSON) || {};
  const seen = new Map();
  for (const [dir, val] of Object.entries(cfg.projects || {})) {
    const k = dir.toLowerCase().replace(/\//g, '\\');
    if (seen.has(k)) Object.assign(seen.get(k).cfg, val || {});
    else seen.set(k, { dir, cfg: { ...(val || {}) } });
  }
  return [...seen.values()];
}

// ~/.claude/projects/<slug> flattens the cwd, so "mylens-src" could be one folder or two.
// Slugifying the known project dirs the same way recovers the real path - and its real name.
const slugOf = (dir) => dir.replace(/[\\/:.]/g, '-').toLowerCase();

function dirsBySlug() {
  const map = new Map();
  for (const { dir } of projectEntries()) map.set(slugOf(dir), dir);
  return map;
}

function pluginDirs() {
  const out = [];
  let markets = [];
  try { markets = fs.readdirSync(MARKETS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const m of markets) {
    if (!m.isDirectory()) continue;
    for (const group of ['plugins', 'external_plugins']) {
      const base = path.join(MARKETS_DIR, m.name, group);
      let entries = [];
      try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory()) out.push({ name: e.name, dir: path.join(base, e.name), market: m.name });
    }
  }
  return out;
}

// npx mcp-remote https://host/mcp -> show the URL, not the wrapper.
function mcpTarget(def) {
  if (!def || typeof def !== 'object') return { transport: 'connector', target: '' };
  if (def.url) return { transport: def.type || (/\/sse\b/.test(def.url) ? 'sse' : 'http'), target: def.url };
  const args = Array.isArray(def.args) ? def.args : [];
  const remote = args.find((a) => /^https?:\/\//.test(String(a)));
  return {
    transport: remote ? 'stdio → remote' : 'stdio',
    target: remote || clip([def.command, ...args].filter(Boolean).join(' '), 140),
  };
}

function mcpInventory() {
  const cfg = readJson(CLAUDE_JSON) || {};
  const auth = readJson(MCP_AUTH_CACHE) || {};
  const unauthed = new Set(Object.keys(auth).map(idKey));
  const rows = new Map();

  const add = (name, scope, def, extra = {}) => {
    const key = scope + '|' + name;
    const hit = rows.get(key);
    if (hit) { Object.assign(hit, extra); return hit; }
    const { transport, target } = mcpTarget(def);
    const row = {
      name, scope, transport, target,
      env: def?.env ? Object.keys(def.env) : [],
      // `target` is a friendly summary (an mcp-remote wrapper is unwrapped to its URL, long
      // commands are clipped), so it cannot be parsed back into a definition. The editor needs
      // the real thing or saving would rewrite the server as something it never was.
      def: def && typeof def === 'object' ? {
        command: def.command || '',
        args: Array.isArray(def.args) ? def.args : [],
        url: def.url || '',
        type: def.type || '',
        env: def.env && typeof def.env === 'object' ? def.env : {},
      } : null,
      projects: [], enabled: true, needsAuth: unauthed.has(idKey(name)), plugin: null, file: null,
      ...extra,
    };
    rows.set(key, row);
    return row;
  };

  for (const [name, def] of Object.entries(cfg.mcpServers || {})) add(name, 'user', def);

  for (const { dir, cfg: pcfg } of projectEntries()) {
    const label = leaf(dir);
    for (const [name, def] of Object.entries(pcfg.mcpServers || {})) {
      const row = add(name, 'local', def);
      if (!row.projects.includes(label)) row.projects.push(label);
    }

    const shared = readJson(path.join(dir, '.mcp.json'));
    if (!shared?.mcpServers) continue;
    const local = readJson(path.join(dir, '.claude', 'settings.local.json')) || {};
    const proj = readJson(path.join(dir, '.claude', 'settings.json')) || {};
    const allOn = !!(local.enableAllProjectMcpServers || proj.enableAllProjectMcpServers);
    const on = new Set([
      ...(pcfg.enabledMcpjsonServers || []), ...(local.enabledMcpjsonServers || []), ...(proj.enabledMcpjsonServers || []),
    ].map(idKey));
    const off = new Set((pcfg.disabledMcpjsonServers || []).map(idKey));
    for (const [name, def] of Object.entries(shared.mcpServers)) {
      const row = add(name, 'project', def, { file: path.join(dir, '.mcp.json') });
      row.enabled = (allOn || on.has(idKey(name))) && !off.has(idKey(name));
      if (!row.projects.includes(label)) row.projects.push(label);
    }
  }

  // Available from the plugin marketplace but not wired into this machine unless installed.
  for (const p of pluginDirs()) {
    const def = readJson(path.join(p.dir, '.mcp.json'));
    for (const [name, d] of Object.entries(def?.mcpServers || {})) {
      add(name, 'marketplace', d, { plugin: p.name, enabled: false });
    }
  }

  // claude.ai connectors live server-side; the auth cache is the only on-disk trace of them.
  const known = new Set([...rows.values()].map((r) => idKey(r.name)));
  for (const key of Object.keys(auth)) {
    if (!/^claude\.ai /i.test(key) || known.has(idKey(key))) continue;
    add(key, 'connector', null, { needsAuth: true, target: 'authorise it in your claude.ai connector settings' });
  }

  return [...rows.values()];
}

function skillRows() {
  const rows = [];
  const push = (file, scope, source) => {
    const fm = frontmatter(file);
    rows.push({
      name: fm.name || leaf(path.dirname(file)),
      description: clip(fm.description || '', 400),
      scope, source, file,
    });
  };
  for (const f of findFiles(path.join(CLAUDE_DIR, 'skills'), /^SKILL\.md$/i, 3)) push(f, 'user', 'personal');
  for (const { dir } of projectEntries()) {
    for (const f of findFiles(path.join(dir, '.claude', 'skills'), /^SKILL\.md$/i, 3)) push(f, 'project', leaf(dir));
  }
  for (const p of pluginDirs()) {
    for (const f of findFiles(path.join(p.dir, 'skills'), /^SKILL\.md$/i, 2)) push(f, 'marketplace', p.name);
  }
  return rows;
}

function mdRows(sub) {
  const rows = [];
  const push = (file, scope, source) => {
    const fm = frontmatter(file);
    rows.push({
      name: fm.name || leaf(file).replace(/\.md$/i, ''),
      description: clip(fm.description || '', 300),
      model: fm.model || null,
      scope, source, file,
    });
  };
  for (const f of findFiles(path.join(CLAUDE_DIR, sub), /\.md$/i, 3)) push(f, 'user', 'personal');
  for (const { dir } of projectEntries()) {
    for (const f of findFiles(path.join(dir, '.claude', sub), /\.md$/i, 3)) push(f, 'project', leaf(dir));
  }
  for (const p of pluginDirs()) {
    for (const f of findFiles(path.join(p.dir, sub), /\.md$/i, 2)) push(f, 'marketplace', p.name);
  }
  return rows;
}

/* --- rules: the standing instructions Claude follows, wherever they are written down --- */

const stripFrontmatter = (text) => text.replace(/^﻿?---[\s\S]*?\r?\n---\r?\n?/, '');
const squash = (text) => text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim();

function head(file, bytes = 6144) {
  try { return readSlice(file, 0, bytes); } catch { return ''; }
}

// ~/.claude/projects/<slug>/memory/*.md - the auto-memory, plus its MEMORY.md index.
function memoryRows() {
  const rows = [];
  const bySlug = dirsBySlug();
  let slugs = [];
  try { slugs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return rows; }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const memDir = path.join(PROJECTS_DIR, slug.name, 'memory');
    let files = [];
    try { files = fs.readdirSync(memDir).filter((f) => /\.md$/i.test(f)); } catch { continue; }
    const known = bySlug.get(slug.name.toLowerCase());
    const project = known ? leaf(known) : (slug.name.split('-').filter(Boolean).pop() || slug.name);
    for (const f of files) {
      const file = path.join(memDir, f);
      const text = head(file);
      const fm = frontmatter(file);
      const isIndex = /^MEMORY\.md$/i.test(f);
      let stat; try { stat = fs.statSync(file); } catch { stat = null; }
      rows.push({
        name: fm.name || f.replace(/\.md$/i, ''),
        description: clip(fm.description || '', 300),
        // frontmatter() folds the nested metadata block, so pull the type straight out.
        kind: isIndex ? 'index' : (/^\s+type:\s*(.+)$/m.exec(text)?.[1] || '').trim(),
        preview: clip(squash(stripFrontmatter(text)), 300),
        project, file, isIndex,
        modified: stat ? stat.mtimeMs : 0,
      });
    }
  }
  return rows;
}

// The home directory is itself a "project" in ~/.claude.json, so a naive scan finds every repo's
// CLAUDE.md twice. Keyed by path, and the deepest owning project wins.
function claudeMdRows() {
  const rows = new Map();
  const add = (file, scope, source, ownerLen) => {
    let stat; try { stat = fs.statSync(file); } catch { return; }
    const key = file.toLowerCase();
    const prev = rows.get(key);
    if (prev && prev.ownerLen >= ownerLen) return;
    const text = head(file);
    rows.set(key, {
      name: leaf(file), scope, source, file, ownerLen,
      bytes: stat.size,
      modified: stat.mtimeMs,
      // Headings are structure, not instruction - the prose says what the rule actually is.
      preview: clip(squash(text.replace(/^#+ .*$/gm, '')), 300),
    });
  };
  const userMd = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (fs.existsSync(userMd)) add(userMd, 'user', 'personal', Infinity);
  for (const { dir } of projectEntries()) {
    for (const f of findFiles(dir, /^CLAUDE(\.local)?\.md$/i, 3)) add(f, 'project', leaf(dir), dir.length);
  }
  return [...rows.values()].map(({ ownerLen, ...row }) => row);
}

// Same trap: <home>/.claude/settings.json IS ~/.claude/settings.json, so dedupe by path.
function settingsSources() {
  const seen = new Map();
  const add = (file, scope, source) => {
    const key = path.normalize(file).toLowerCase();
    if (!seen.has(key)) seen.set(key, { file, scope, source });
  };
  add(path.join(CLAUDE_DIR, 'settings.json'), 'user', 'personal');
  add(path.join(CLAUDE_DIR, 'settings.local.json'), 'user', 'personal (local)');
  for (const { dir } of projectEntries()) {
    add(path.join(dir, '.claude', 'settings.json'), 'project', leaf(dir));
    add(path.join(dir, '.claude', 'settings.local.json'), 'project', leaf(dir) + ' (local)');
  }
  return [...seen.values()];
}

function hookRows() {
  const rows = [];
  for (const { file, scope, source } of settingsSources()) {
    const cfg = readJson(file);
    for (const [event, matchers] of Object.entries(cfg?.hooks || {})) {
      for (const m of Array.isArray(matchers) ? matchers : []) {
        for (const hk of Array.isArray(m?.hooks) ? m.hooks : []) {
          rows.push({
            event, matcher: m.matcher || '*', type: hk.type || 'command',
            command: clip(String(hk.command || ''), 300), scope, source, file,
          });
        }
      }
    }
  }
  return rows;
}

function permissionRows() {
  const rows = [];
  for (const { file, scope, source } of settingsSources()) {
    const perms = readJson(file)?.permissions;
    if (!perms) continue;
    for (const kind of ['allow', 'ask', 'deny']) {
      for (const rule of perms[kind] || []) rows.push({ kind, rule: clip(String(rule), 220), scope, source, file });
    }
  }
  // Older allow-lists live on the project record in ~/.claude.json instead.
  for (const { dir, cfg } of projectEntries()) {
    for (const rule of cfg.allowedTools || []) {
      rows.push({ kind: 'allow', rule: clip(String(rule), 220), scope: 'project', source: leaf(dir), file: CLAUDE_JSON });
    }
  }
  return rows;
}

let toolboxCache = { at: 0, data: null };

function toolbox() {
  const now = Date.now();
  if (toolboxCache.data && now - toolboxCache.at < TOOLBOX_TTL) return toolboxCache.data;
  const cfg = readJson(CLAUDE_JSON) || {};
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json')) || {};
  const data = {
    generatedAt: now,
    mcp: mcpInventory(),
    skills: skillRows(),
    agents: mdRows('agents'),
    commands: mdRows('commands'),
    skillUsage: cfg.skillUsage || {},
    settings,
    rules: {
      memory: memoryRows(),
      claudeMd: claudeMdRows(),
      hooks: hookRows(),
      permissions: permissionRows(),
    },
    projects: projectEntries().map(({ dir, cfg: pcfg }) => {
      const local = readJson(path.join(dir, '.claude', 'settings.local.json')) || {};
      return {
        name: leaf(dir),
        dir,
        trusted: !!pcfg.hasTrustDialogAccepted,
        allowRules: (local.permissions?.allow || []).length + (pcfg.allowedTools || []).length,
        mcpLocal: Object.keys(pcfg.mcpServers || {}),
        mcpEnabled: [...new Set([...(pcfg.enabledMcpjsonServers || []), ...(local.enabledMcpjsonServers || [])])],
        hasMcpFile: fs.existsSync(path.join(dir, '.mcp.json')),
      };
    }),
    dirs: { claude: CLAUDE_DIR, markets: MARKETS_DIR, config: CLAUDE_JSON },
  };
  toolboxCache = { at: now, data };
  return data;
}

// ---------------------------------------------------------------- actions

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const hasWt = (() => {
  try { execFileSync('where', ['wt.exe'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// The desktop app installs its own claude.exe under a version-numbered folder and never
// puts it on PATH, so `where claude` finds nothing on machines that only have the desktop
// app. Fall back to the newest versioned install before giving up.
const CLAUDE_BIN = (() => {
  try {
    const out = execFileSync('where', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first) return first;
  } catch {}
  const roots = [
    path.join(HOME, 'AppData', 'Roaming', 'Claude', 'claude-code'),
    path.join(HOME, 'AppData', 'Local', 'Claude', 'claude-code'),
  ];
  for (const root of roots) {
    let versions;
    try { versions = fs.readdirSync(root); } catch { continue; }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const exe = path.join(root, v, 'claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
})();

// Pasted screenshots. There is no CLI flag for attaching an image to a resumed prompt, so
// they land next to the prompt file on disk and the message points Claude at the paths.
const IMAGE_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif',
};
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function writePastedImages(dir, images) {
  const out = [];
  if (!Array.isArray(images)) return out;
  for (const img of images.slice(0, MAX_IMAGES)) {
    const ext = IMAGE_EXT[String(img?.type || '').toLowerCase().trim()];
    if (!ext) continue;
    const b64 = String(img.data || '').replace(/^data:[^,]*,/, '');
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    // The name is ours, never the client's - a pasted filename must not choose the path.
    const file = path.join(dir, `pasted-${out.length + 1}${ext}`);
    fs.writeFileSync(file, buf);
    out.push(file);
  }
  return out;
}

// A running session cannot be retuned from outside, so --model / --effort apply to the fresh
// window this opens. Both are whitelisted before they ever reach a command line.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_SHAPE = /^[A-Za-z0-9._[\]-]{1,64}$/;

// Open a terminal running claude: resuming `id` when given one, otherwise a brand new chat.
// The message goes through a temp file, so nothing in it needs shell escaping.
function launchTerminal({ id, cwd, message, images, model, effort }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralias-cockpit-'));
  const shots = writePastedImages(dir, images);
  let text = typeof message === 'string' ? message.trim() : '';
  if (shots.length) {
    const many = shots.length > 1;
    text = (text ? text + '\n\n' : '') +
      shots.map((f) => `[pasted image] ${f}`).join('\n') +
      `\n\n(read the image file${many ? 's' : ''} above with the Read tool before replying)`;
  }
  const wantModel = typeof model === 'string' && MODEL_SHAPE.test(model.trim()) ? model.trim() : null;
  const wantEffort = EFFORT_LEVELS.has(String(effort || '').trim()) ? String(effort).trim() : null;
  const flags = [
    ...(wantModel ? ['--model', psQuote(wantModel)] : []),
    ...(wantEffort ? ['--effort', psQuote(wantEffort)] : []),
  ].join(' ');
  // Bare `claude` only resolves if it's on PATH - not guaranteed for a desktop-app install.
  const claudeCmd = CLAUDE_BIN ? `& ${psQuote(CLAUDE_BIN)}` : 'claude';
  const invoke = `${claudeCmd}${id ? ' --resume ' + psQuote(id) : ''}${flags ? ' ' + flags : ''}`;

  let body = '';
  if (text) {
    const promptFile = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptFile, text, 'utf8');
    // -Encoding UTF8 matters: PowerShell 5.1 reads BOM-less files as ANSI and would mangle accents/emoji.
    body = `$prompt = Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(promptFile)}\n` +
           `${invoke} $prompt\n`;
  } else {
    body = `${invoke}\n`;
  }
  const script = [
    `$ErrorActionPreference = 'Continue'`,
    cwd ? `Set-Location -LiteralPath ${psQuote(cwd)}` : '',
    `Write-Host 'Rals Cockpit: ${id ? 'resuming session ' + id : 'new chat'}' -ForegroundColor Cyan`,
    body,
  ].filter(Boolean).join('\n');
  const scriptFile = path.join(dir, 'resume.ps1');
  fs.writeFileSync(scriptFile, script, 'utf8');

  const psArgs = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
  if (process.env.FLEET_DRY_RUN === '1') return { terminal: 'dry run (nothing launched)', scriptFile, images: shots.length, model: wantModel, effort: wantEffort };
  const title = id ? `claude ${id.slice(0, 8)}` : 'claude (new chat)';
  const child = hasWt
    ? spawn('wt.exe', ['-w', '0', 'nt', '--title', title, 'powershell', ...psArgs], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('cmd.exe', ['/c', 'start', '""', 'powershell', ...psArgs], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { terminal: hasWt ? 'Windows Terminal' : 'PowerShell window', scriptFile, images: shots.length, model: wantModel, effort: wantEffort };
}

/* ------------------------------------------------- provider keys

   The only secret this app stores for you. Same trust model as an MCP server's `env` block
   (plaintext JSON next to the server, protected by the filesystem and the app's own TOKEN/ACCESS
   gate) - not a vault, just the same convention the rest of this app already uses. Never echoed
   back whole once saved. */

const PROVIDER_KEYS_FILE = process.env.FLEET_PROVIDER_KEYS_FILE || path.join(HERE, 'provider-keys.json');
let providerKeys = readJson(PROVIDER_KEYS_FILE) || {};

function saveProviderKey(provider, key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('that key looks empty');
  if (k.length > 400) throw new Error('that is longer than any real API key');
  const backup = toTrash(PROVIDER_KEYS_FILE);
  const next = { ...providerKeys, [provider]: { key: k, savedAt: Date.now() } };
  writeAtomic(PROVIDER_KEYS_FILE, JSON.stringify(next, null, 2));
  providerKeys = next;
  return { backup };
}

function deleteProviderKey(provider) {
  if (!providerKeys[provider]) return false;
  toTrash(PROVIDER_KEYS_FILE);
  const next = { ...providerKeys };
  delete next[provider];
  writeAtomic(PROVIDER_KEYS_FILE, JSON.stringify(next, null, 2));
  providerKeys = next;
  return true;
}

const getOpenAIKey = () => providerKeys.openai?.key || '';

// Never the raw key - just enough to recognise it was set without re-showing it.
function providerKeysPublic() {
  const out = {};
  for (const [id, rec] of Object.entries(providerKeys)) {
    out[id] = { set: true, last4: String(rec.key || '').slice(-4) };
  }
  return out;
}

/* ------------------------------------------------- providers registry

   Claude Code is a local CLI with its own on-disk transcripts and a resumable process - full
   parity (live status, resume in a terminal). OpenAI has neither: it's an API key, and every
   "session" only exists because this app created it. A future local-CLI agent (Codex, Gemini,
   ...) would register here the same way Claude does, once one is actually installed to build
   against - see server/providers/openai.mjs for the template such a provider would copy. */
function providersPayload() {
  return {
    claude: {
      label: 'Claude Code', kind: 'cli', configured: true,
      canResumeInTerminal: true, hasFolder: true, hasStance: true, models: null, efforts: null,
    },
    openai: {
      label: 'ChatGPT', kind: 'api-key', configured: !!getOpenAIKey(),
      canResumeInTerminal: false, hasFolder: false, hasStance: false,
      models: OPENAI_MODELS, efforts: [],
    },
  };
}

/* ------------------------------------------------- your layer of the app

   Sections, which cards are open, what you dismissed, the theme. This used to live only in one
   browser's localStorage, so a different browser - and your phone in particular - saw none of it.
   It lives next to the server now and the browser keeps a mirror for instant paints. */

// Overridable so a test run can point it at a scratch file instead of your real settings.
const PREFS_FILE = process.env.FLEET_PREFS_FILE || path.join(HERE, 'prefs.json');
const PREF_KEYS = new Set([
  'sections', 'section', 'expanded', 'dismissed', 'collapsed', 'theme', 'filter', 'groupby',
  'view', 'stance', 'chatmodel', 'chateffort', 'notify', 'usagedays', 'drawerwho',
]);
const PREFS_MAX = 256 * 1024;

let prefs = readJson(PREFS_FILE) || {};

function savePrefs(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('nothing to save');
  const next = { ...prefs };
  for (const [k, v] of Object.entries(patch)) {
    if (!PREF_KEYS.has(k)) continue;         // ignore anything we do not recognise
    if (v === null) delete next[k]; else next[k] = v;
  }
  const text = JSON.stringify(next, null, 2);
  if (text.length > PREFS_MAX) throw new Error('that is more preference data than this keeps');
  prefs = next;
  try { fs.writeFileSync(PREFS_FILE, text, 'utf8'); } catch { /* memory copy still serves this run */ }
  return prefs;
}

/* ------------------------------------------------- full-text search over transcripts

   The board's filter only ever saw the digest of each transcript's tail. This reads the files -
   cheaply, by looking for the needle in the raw text before parsing anything - so "which chat did
   I fix the tally slip in" becomes answerable. */

function searchTranscripts(needle, { limit = 40, perFile = 3 } = {}) {
  const q = String(needle || '').trim();
  if (q.length < 2) return { query: q, hits: [], files: 0, scanned: 0, tooShort: true };
  const lower = q.toLowerCase();
  const bySlug = dirsBySlug();
  const hits = [];
  let scanned = 0, files = 0;

  const entries = [...transcriptIndex().entries()].sort((a, b) => b[1].stat.mtimeMs - a[1].stat.mtimeMs);
  for (const [id, entry] of entries) {
    if (hits.length >= limit) break;
    scanned++;
    let text = '';
    try { text = fs.readFileSync(entry.file, 'utf8'); } catch { continue; }
    if (!text.toLowerCase().includes(lower)) continue;
    files++;
    const known = bySlug.get(entry.projectSlug.toLowerCase());
    const project = known ? leaf(known) : (entry.projectSlug.split('-').filter(Boolean).pop() || entry.projectSlug);
    const title = digestTranscript(entry.file, entry.stat).title;
    let found = 0;
    for (const line of text.split('\n')) {
      if (found >= perFile || hits.length >= limit) break;
      if (line.length < 2 || line[0] !== '{' || !line.toLowerCase().includes(lower)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'user' && row.type !== 'assistant') continue;
      const body = textOf(row.message?.content);
      const at = body.toLowerCase().indexOf(lower);
      if (at < 0) continue;                  // the match was in metadata, not in what was said
      found++;
      hits.push({
        id, project, title, role: row.type, ts: row.timestamp || null,
        before: body.slice(Math.max(0, at - 90), at),
        match: body.slice(at, at + q.length),
        after: body.slice(at + q.length, at + q.length + 130),
      });
    }
  }
  return { query: q, hits, files, scanned, tooShort: false };
}

/* ------------------------------------------------- export a conversation */

function exportMarkdown(id) {
  const convo = readConversation(id, 600);
  if (!convo) return null;
  const out = [`# ${convo.title || id}`, '', `Session \`${id}\``, ''];
  for (const m of convo.items) {
    const who = m.sidechain ? 'Subagent' : m.role === 'user' ? (m.isToolTurn ? 'Tool result' : 'You') : 'Claude';
    const when = m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : '';
    out.push(`## ${who}${when}`, '');
    if (m.text) out.push(m.text, '');
    if (m.images?.length) out.push(`_${m.images.length} image(s)_`, '');
    if (m.tools?.length) {
      out.push(...m.tools.map((t) => `- \`${t.name}\`${t.target ? ' ' + t.target : ''}`), '');
    }
    if (!m.text && !m.tools?.length && m.results) out.push(`_${m.results} tool result(s)_`, '');
  }
  return out.join('\n');
}

/* ------------------------------------------------- editing rules, skills and MCP servers

   These files decide how Claude behaves and what it may do without asking, so the write path is
   deliberately narrow:

   - The client never supplies a path to write. It may only name a file the server itself already
     listed in the inventory, and marketplace plugin files are excluded because an edit there is
     erased by the next plugin update.
   - New files get their path built by the server from a validated name plus a known scope.
   - Every write and delete copies the original into trash/ first, so nothing is unrecoverable.
   - Writes are atomic (temp file, verify it re-parses if it is JSON, then rename) because
     ~/.claude.json also holds your account and caches - a half-written one would be a bad day. */

const TRASH_DIR = path.join(HERE, 'trash');
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

function editableTargets() {
  const t = toolbox();
  const map = new Map(); // normalised lowercase path -> { file, kind, readOnly }
  const add = (file, kind, scope) => {
    if (!file) return;
    if (scope === 'marketplace') return;      // upstream copy; editing it is a lie
    map.set(path.normalize(file).toLowerCase(), { file, kind });
  };
  for (const r of t.rules.memory) add(r.file, 'memory');
  for (const r of t.rules.claudeMd) add(r.file, 'claudemd');
  for (const r of t.skills) add(r.file, 'skill', r.scope);
  for (const r of t.agents) add(r.file, 'agent', r.scope);
  for (const r of t.commands) add(r.file, 'command', r.scope);
  for (const r of t.mcp) add(r.file, 'mcpfile', r.scope);
  for (const s of settingsSources()) add(s.file, 'settings');
  add(CLAUDE_JSON, 'claudejson');
  return map;
}

function resolveEditable(given) {
  const key = path.normalize(String(given || '')).toLowerCase();
  const hit = editableTargets().get(key);
  if (!hit) throw new Error('that file is not one this app offers to edit');
  return hit.file;
}

const TRASH_KEEP = Number(process.env.FLEET_TRASH_KEEP || 200);

// Backups are a safety net and an accidental version history, but not an unbounded one.
function pruneTrash() {
  try {
    const files = fs.readdirSync(TRASH_DIR)
      .map((f) => ({ f, at: fs.statSync(path.join(TRASH_DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of files.slice(TRASH_KEEP)) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
    return files.length;
  } catch { return 0; }
}

function toTrash(file) {
  try {
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(TRASH_DIR, `${stamp}__${leaf(file)}`);
    fs.copyFileSync(file, dest);
    pruneTrash();
    return dest;
  } catch (e) {
    throw new Error('could not back that file up, so nothing was changed: ' + e.message);
  }
}

// trash/ names are "<iso stamp>__<basename>", so it doubles as a per-file version history.
function trashVersions() {
  let names = [];
  try { names = fs.readdirSync(TRASH_DIR); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const m = /^(.+?)__(.+)$/.exec(name);
    if (!m) continue;
    let stat; try { stat = fs.statSync(path.join(TRASH_DIR, name)); } catch { continue; }
    rows.push({
      name, of: m[2],
      when: m[1].replace(/-(\d\d)-(\d\d)-(\d{3})Z$/, ':$1:$2Z'),
      at: stat.mtimeMs, bytes: stat.size,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

function readTrashVersion(name) {
  if (!/^[\w.\-:]+__[\w.\-]+$/.test(String(name))) throw new Error('not a backup name');
  const file = path.join(TRASH_DIR, name);
  if (!fs.existsSync(file)) throw new Error('that backup is gone');
  return fs.readFileSync(file, 'utf8');
}

function emptyTrash() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(TRASH_DIR)) { fs.rmSync(path.join(TRASH_DIR, f), { force: true }); n++; }
  } catch { /* nothing there */ }
  return n;
}

/* --- hooks, edited as structure rather than raw JSON --- */

function editHook({ action, file, event, matcher, command }) {
  const target = resolveEditable(file);
  if (!/settings(\.local)?\.json$/i.test(target)) throw new Error('hooks live in a settings file');
  const ev = String(event || '').trim();
  if (!/^[A-Za-z]{3,40}$/.test(ev)) throw new Error('event should be a name like PostToolUse');
  const cmd = String(command || '').trim();
  toTrash(target);
  const json = readJson(target) || {};
  json.hooks = json.hooks || {};
  const list = Array.isArray(json.hooks[ev]) ? json.hooks[ev] : [];

  if (action === 'add') {
    if (!cmd) throw new Error('a hook needs a command to run');
    const match = String(matcher || '').trim() || '*';
    const slot = list.find((m) => (m.matcher || '*') === match);
    if (slot) slot.hooks = [...(slot.hooks || []), { type: 'command', command: cmd }];
    else list.push({ matcher: match, hooks: [{ type: 'command', command: cmd }] });
    json.hooks[ev] = list;
  } else {
    for (const slot of list) slot.hooks = (slot.hooks || []).filter((h) => h.command !== cmd);
    json.hooks[ev] = list.filter((slot) => (slot.hooks || []).length);
    if (!json.hooks[ev].length) delete json.hooks[ev];
  }
  writeAtomic(target, JSON.stringify(json, null, 2) + '\n');
  return { file: target, event: ev, action };
}

function writeAtomic(file, text) {
  if (/\.json$/i.test(file)) {
    try { JSON.parse(text); } catch (e) { throw new Error('that is not valid JSON: ' + e.message); }
  }
  const tmp = file + '.cockpit-tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  if (/\.json$/i.test(file)) {
    // Read it back off disk before it becomes the real thing.
    try { JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch (e) { fs.rmSync(tmp, { force: true }); throw new Error('the written file did not parse: ' + e.message); }
  }
  fs.renameSync(tmp, file);
  toolboxCache = { at: 0, data: null };
}

const TEMPLATES = {
  memory: (name) => `---\nname: ${name}\ndescription: "one line, used to decide relevance later"\nmetadata:\n  type: project\n---\n\nThe fact worth remembering.\n`,
  skill: (name) => `---\nname: ${name}\ndescription: What this does and when to use it. Be specific - this line is how it gets picked.\n---\n\n# ${name}\n\nSteps go here.\n`,
  agent: (name) => `---\nname: ${name}\ndescription: When to hand work to this agent.\n---\n\nWhat this agent should do.\n`,
  command: (name) => `---\ndescription: What /${name} does.\n---\n\nWhat should happen when this command runs.\n`,
  claudemd: () => `# Project instructions\n\nThings Claude should always know about this repo.\n`,
};

// The path is composed here from a validated name and a known scope - never taken from a client.
function newFilePath({ kind, scope, project, name }) {
  const clean = String(name || '').trim();
  if (kind !== 'claudemd' && !NAME_SHAPE.test(clean)) {
    throw new Error('use letters, numbers, dots, dashes or underscores (max 61 chars)');
  }
  const base = scope === 'user' ? CLAUDE_DIR : (() => {
    const dir = projectEntries().find(({ dir: d }) => leaf(d) === project || d === project)?.dir;
    if (!dir) throw new Error('unknown project');
    return path.join(dir, '.claude');
  })();

  if (kind === 'memory') {
    if (scope !== 'project') throw new Error('memory lives per project');
    const dir = projectEntries().find(({ dir: d }) => leaf(d) === project || d === project)?.dir;
    const slug = slugOf(dir);
    const found = fs.readdirSync(PROJECTS_DIR).find((s) => s.toLowerCase() === slug);
    if (!found) throw new Error('that project has no session history yet, so it has no memory folder');
    return path.join(PROJECTS_DIR, found, 'memory', clean.replace(/\.md$/i, '') + '.md');
  }
  if (kind === 'skill') return path.join(base, 'skills', clean, 'SKILL.md');
  if (kind === 'agent') return path.join(base, 'agents', clean + '.md');
  if (kind === 'command') return path.join(base, 'commands', clean + '.md');
  if (kind === 'claudemd') {
    if (scope === 'user') return path.join(CLAUDE_DIR, 'CLAUDE.md');
    const dir = projectEntries().find(({ dir: d }) => leaf(d) === project || d === project)?.dir;
    if (!dir) throw new Error('unknown project');
    return path.join(dir, 'CLAUDE.md');
  }
  throw new Error('unknown kind: ' + kind);
}

/* --- MCP servers: structured edits, so a typo cannot corrupt ~/.claude.json --- */

function mcpDefFrom(body) {
  const name = String(body.name || '').trim();
  if (!NAME_SHAPE.test(name)) throw new Error('server name: letters, numbers, dots, dashes, underscores');
  const kind = body.transport === 'http' || body.transport === 'sse' ? body.transport : 'stdio';
  if (kind === 'stdio') {
    const command = String(body.command || '').trim();
    if (!command) throw new Error('a stdio server needs a command');
    // One per line: splitting on whitespace broke any argument containing a space.
    const args = String(body.args || '').split('\n').map((a) => a.trim()).filter(Boolean);
    const def = { command, ...(args.length ? { args } : {}) };
    const env = {};
    for (const line of String(body.env || '').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim();
    }
    if (Object.keys(env).length) def.env = env;
    return { name, def };
  }
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('an http/sse server needs an http(s) URL');
  return { name, def: { type: kind, url } };
}

function mcpTargetFile(scope, project) {
  if (scope === 'user') return { file: CLAUDE_JSON, at: 'user' };
  const dir = projectEntries().find(({ dir: d }) => leaf(d) === project || d === project)?.dir;
  if (!dir) throw new Error('unknown project');
  return { file: path.join(dir, '.mcp.json'), at: 'project', dir };
}

function saveMcpServer(body) {
  const { name, def } = mcpDefFrom(body);
  const { file, at } = mcpTargetFile(body.scope, body.project);
  const original = body.originalName && body.originalName !== name ? String(body.originalName) : null;
  toTrash(file);
  const json = readJson(file) || (at === 'user' ? {} : { mcpServers: {} });
  json.mcpServers = json.mcpServers || {};
  if (original) delete json.mcpServers[original];
  json.mcpServers[name] = def;
  writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
  return { name, file, transport: body.transport || 'stdio' };
}

function deleteMcpServer(body) {
  const name = String(body.name || '');
  const { file } = mcpTargetFile(body.scope, body.project);
  const json = readJson(file);
  if (!json?.mcpServers || !(name in json.mcpServers)) throw new Error('no such server in that file');
  const backup = toTrash(file);
  delete json.mcpServers[name];
  writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
  return { name, file, backup };
}

/* --- permission rules --- */

function editPermission({ action, file, kind, rule }) {
  const target = resolveEditable(file);
  if (!/settings(\.local)?\.json$/i.test(target)) throw new Error('permissions live in a settings file');
  if (!['allow', 'ask', 'deny'].includes(kind)) throw new Error('kind must be allow, ask or deny');
  const text = String(rule || '').trim();
  if (!text) throw new Error('empty rule');
  toTrash(target);
  const json = readJson(target) || {};
  json.permissions = json.permissions || {};
  const list = Array.isArray(json.permissions[kind]) ? json.permissions[kind] : [];
  if (action === 'add') {
    if (list.includes(text)) throw new Error('that rule is already there');
    json.permissions[kind] = [...list, text];
  } else {
    if (!list.includes(text)) throw new Error('that rule is not in this file');
    json.permissions[kind] = list.filter((r) => r !== text);
  }
  writeAtomic(target, JSON.stringify(json, null, 2) + '\n');
  return { file: target, kind, rule: text, count: json.permissions[kind].length };
}

/* ------------------------------------------------- in-page chat

   Instead of opening a terminal, run Claude headless and stream it to the browser:
     claude -p --verbose --output-format stream-json --include-partial-messages
   which emits one JSON object per line (system/init, stream_event deltas, assistant, result).

   The catch that shapes the whole design: print mode has no way to ask you about a tool call.
   There is no --permission-prompt-tool in this CLI, so the only levers are a pre-agreed
   allow-list or a permission mode chosen up front. Hence `stance` below - and why "read only"
   is the default. */

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill'];
const STANCES = {
  read: { label: 'read only', args: ['--allowedTools', ...READ_ONLY_TOOLS] },
  edit: { label: 'can edit files', args: ['--permission-mode', 'acceptEdits'] },
  full: { label: 'anything, no prompts', args: ['--permission-mode', 'bypassPermissions'] },
};

/* A chat you had in this page has no terminal process, so with no record of its own it drops
   into history and disappears behind the Live filter the moment the panel closes. This is that
   record, kept on disk so it survives a restart. */
const CHATS_FILE = path.join(HERE, 'chats.json');
const inPageChats = new Map();

(() => {
  const saved = readJson(CHATS_FILE);
  for (const c of Array.isArray(saved?.chats) ? saved.chats : []) {
    if (c && typeof c.id === 'string') inPageChats.set(c.id, c);
  }
})();

function rememberChat(id, cwd) {
  const prev = inPageChats.get(id);
  inPageChats.set(id, {
    id, cwd,
    firstAt: prev?.firstAt || Date.now(),
    lastAt: Date.now(),
    turns: (prev?.turns || 0) + 1,
  });
  try {
    fs.writeFileSync(CHATS_FILE, JSON.stringify({ chats: [...inPageChats.values()] }, null, 2), 'utf8');
  } catch { /* the board still works from memory for this run */ }
}

const RUN_TTL = 30 * 60 * 1000;
const MAX_RUN_EVENTS = 1200;
const runs = new Map(); // runId -> { events, done, subscribers, child, sessionId, cwd, startedAt, exit }

let lastRateLimit = null; // the API tells us this on every headless turn; nothing on disk does

/* Token-level streaming emits about two events per token, so buffering every one of them meant a
   long answer overflowed the replay buffer and a reader who joined late saw it from the middle.
   The buffer now keeps the accumulated text instead: deltas are folded into one synthetic event
   that carries the whole answer so far, while live subscribers still get them token by token. */
function emit(run, event) {
  const delta = event.type === 'stream_event' && event.event?.delta;
  if (delta?.type === 'text_delta') {
    run.text = (run.text || '') + delta.text;
    if (run.textEvent) run.textEvent.text = run.text;
    else { run.textEvent = { type: 'fleet_text', text: run.text }; run.events.push(run.textEvent); }
  } else if (delta?.type === 'thinking_delta') {
    // Thinking is shown as a status, never replayed, so it never needs buffering.
  } else if (run.events.length < MAX_RUN_EVENTS) {
    run.events.push(event);
  } else if (!run.overflowed) {
    run.overflowed = true;
    run.events.push({ type: 'fleet_note', text: 'this run produced more events than the replay buffer keeps' });
  }
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of run.subscribers) res.write(line);
}

function sweepRuns() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (run.done && now - (run.endedAt || run.startedAt) > RUN_TTL && !run.subscribers.size) runs.delete(id);
  }
}
setInterval(sweepRuns, 5 * 60 * 1000).unref?.();

function startChat({ id, cwd, message, images, model, effort, stance, fromThisPc = true }) {
  // "anything, no prompts" runs every tool unasked. That is a decision for someone sitting at the
  // machine, not for whoever paired a phone to it.
  if (stance === 'full' && !fromThisPc) {
    throw new Error('the no-prompts stance is only available on this PC, not over the network');
  }
  let stat;
  try { stat = fs.statSync(cwd); } catch { throw new Error('that folder does not exist'); }
  if (!stat.isDirectory()) throw new Error('that is not a folder');

  const text = String(message || '').trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralias-cockpit-chat-'));
  const shots = writePastedImages(dir, images);
  const prompt = shots.length
    ? (text ? text + '\n\n' : '') + shots.map((f) => `[pasted image] ${f}`).join('\n') +
      `\n\n(read the image file${shots.length > 1 ? 's' : ''} above with the Read tool before replying)`
    : text;
  if (!prompt) throw new Error('nothing to send');

  const chosen = STANCES[stance] || STANCES.read;
  const sessionId = id || crypto.randomUUID();
  const args = [
    '-p', prompt,
    '--verbose',                        // stream-json refuses to run without it
    '--output-format', 'stream-json',
    '--include-partial-messages',
    ...(id ? ['--resume', id] : ['--session-id', sessionId]),
    ...chosen.args,
  ];
  if (typeof model === 'string' && MODEL_SHAPE.test(model.trim())) args.push('--model', model.trim());
  if (EFFORT_LEVELS.has(String(effort || '').trim())) args.push('--effort', String(effort).trim());

  const runId = 'run_' + crypto.randomBytes(8).toString('hex');
  const run = {
    events: [], subscribers: new Set(), done: false, sessionId, cwd, images: shots.length,
    startedAt: Date.now(), stance: chosen.label, resumed: !!id, prompt,
  };
  runs.set(runId, run);
  rememberChat(sessionId, cwd);   // so the card survives closing the panel
  sweepRuns();

  // A PATH shim (npm global install) needs cmd.exe to resolve; a resolved exe path doesn't.
  const child = CLAUDE_BIN && CLAUDE_BIN.toLowerCase().endsWith('.exe')
    ? spawn(CLAUDE_BIN, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('cmd.exe', ['/c', CLAUDE_BIN || 'claude', ...args], {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
  run.child = child;
  run.stop = () => child.kill();

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed[0] !== '{') { emit(run, { type: 'stderr', text: clip(trimmed, 400) }); continue; }
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (event.type === 'rate_limit_event' && event.rate_limit_info) {
        lastRateLimit = { ...event.rate_limit_info, seenAt: Date.now() };
      }
      emit(run, event);
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) emit(run, { type: 'stderr', text: clip(line.trim(), 400) });
    }
  });

  child.on('error', (err) => {
    run.done = true; run.endedAt = Date.now();
    emit(run, { type: 'fleet_end', ok: false, error: String(err.message || err) });
    for (const res of run.subscribers) res.end();
    run.subscribers.clear();
  });

  child.on('close', (code) => {
    run.done = true; run.endedAt = Date.now(); run.exit = code;
    emit(run, {
      type: 'fleet_end',
      ok: code === 0,
      exit: code,
      error: code === 0 ? null : clip(stderr.trim(), 400) || `claude exited with code ${code}`,
    });
    for (const res of run.subscribers) res.end();
    run.subscribers.clear();
  });

  return { runId, sessionId, stance: chosen.label, images: shots.length, resumed: !!id };
}

// OpenAI has no local process to spawn: runOpenAIChat() does the network turn itself and reports
// back through the exact same event vocabulary Claude's spawned process emits above, so this
// reuses the same runs/emit()/SSE machinery with no changes to either.
function startOpenAIChatRun({ id, message, images, model }) {
  if (images?.length) throw new Error('images are not supported for OpenAI chats yet');
  const apiKey = getOpenAIKey();
  const sessionId = id || crypto.randomUUID();
  const runId = 'run_' + crypto.randomBytes(8).toString('hex');
  const run = {
    events: [], subscribers: new Set(), done: false, sessionId, cwd: '', images: 0,
    startedAt: Date.now(), stance: 'ChatGPT', resumed: !!id, prompt: message,
  };
  runs.set(runId, run);
  sweepRuns();

  const endRun = (event) => {
    if (run.done) return;
    run.done = true; run.endedAt = Date.now();
    emit(run, event);
    for (const res of run.subscribers) res.end();
    run.subscribers.clear();
  };

  const openaiRun = runOpenAIChat({
    id: sessionId, message, model, apiKey,
    onEvent: (event) => (event.type === 'fleet_end' ? endRun(event) : emit(run, event)),
  });
  run.stop = openaiRun.stop;
  openaiRun.promise.catch((e) => endRun({ type: 'fleet_end', ok: false, error: String(e?.message || e) }));

  return { runId, sessionId, stance: 'ChatGPT', images: 0, resumed: !!id };
}

function openTarget({ target, cwd, file }) {
  const p = target === 'transcript' || target === 'file' ? file : cwd;
  if (!p) throw new Error('nothing to open');
  if (target === 'file') {
    const child = spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: p };
  }
  if (target === 'code') {
    const child = spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore' });
    child.unref();
  } else if (target === 'explorer') {
    const child = spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' });
    child.unref();
  } else if (target === 'transcript') {
    const child = spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    throw new Error('unknown target: ' + target);
  }
  return { opened: p };
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function localHost(req) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

// The socket, not the Host header - a header is whatever the client felt like sending.
function fromThisMachine(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sameCode(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ACCESS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const codeCookie = () =>
  `fleet_key=${encodeURIComponent(ACCESS)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`;

const failures = new Map(); // remote ip -> { n, until }

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

const UNLOCK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Rals Cockpit</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf5;
font:16px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;padding:24px}
form{width:100%;max-width:340px;text-align:center}
h1{font-size:17px;margin:0 0 6px}
p{margin:0 0 20px;color:#9db0c6;font-size:13.5px}
input{width:100%;padding:15px;font:600 22px/1 ui-monospace,Consolas,monospace;letter-spacing:5px;
text-align:center;text-transform:uppercase;border-radius:12px;border:1px solid #22303f;
background:#141d29;color:#e6edf5;outline:none}
input:focus{border-color:#d97757}
button{width:100%;margin-top:12px;padding:15px;font:600 15px inherit;border:0;border-radius:12px;
background:#d97757;color:#1a0f09;cursor:pointer}
.bad{color:#f87171;font-size:13px;margin-top:12px;min-height:19px}
</style></head><body>
<form id="f"><h1>Rals&nbsp;Cockpit</h1>
<p>Enter the access code shown in the terminal on your PC.</p>
<input id="k" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" autofocus>
<button type="submit">Unlock</button><div class="bad" id="e"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const key = document.getElementById('k').value.trim().toUpperCase();
  const res = await fetch('/api/unlock', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
  if (res.ok) location.replace('/');
  else document.getElementById('e').textContent = (await res.json().catch(()=>({}))).error || 'Wrong code';
});
</script></body></html>`;

function readBody(req, cap = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > cap) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const sseClients = new Set();
let lastPayload = '';

function tick() {
  let state;
  try { state = buildState(); } catch (e) { state = { error: String(e?.message || e), sessions: [], stats: {} }; }
  const body = JSON.stringify(state);
  // Ignore the timestamp when deciding whether anything actually changed.
  const fingerprint = body.replace(/"generatedAt":\d+,/, '');
  if (fingerprint !== lastPayload) {
    lastPayload = fingerprint;
    for (const res of sseClients) res.write(`event: state\ndata: ${body}\n\n`);
  }
}

const server = http.createServer(async (req, res) => {
  if (!LAN && !localHost(req)) { res.writeHead(403).end('Rals Cockpit is loopback only'); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    // Anything arriving from another device has to hold the access code.
    if (LAN && !fromThisMachine(req)) {
      const ip = String(req.socket.remoteAddress || '?');
      const lock = failures.get(ip);
      const lockedOut = lock && lock.until > Date.now();

      if (p === '/api/unlock') {
        if (req.method !== 'POST') return json(res, 405, { error: 'post only' });
        if (lockedOut) return json(res, 429, { error: 'too many attempts — try again in a few minutes' });
        const body = await readBody(req, 4096).catch(() => ({}));
        if (sameCode(String(body.key || '').trim().toUpperCase())) {
          failures.delete(ip);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': codeCookie(), 'cache-control': 'no-store' });
          return res.end('{"ok":true}');
        }
        const n = (lock?.n || 0) + 1;
        failures.set(ip, { n, until: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
        return json(res, 403, { error: n >= LOCK_AFTER ? 'locked for 10 minutes' : 'wrong code' });
      }

      const supplied = url.searchParams.get('k') || cookies(req).fleet_key || req.headers['x-fleet-key'];
      if (lockedOut || !sameCode(typeof supplied === 'string' ? supplied.trim().toUpperCase() : '')) {
        if (p.startsWith('/api/')) return json(res, 401, { error: 'locked — open / and enter the access code' });
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(UNLOCK_PAGE);
      }
      // Code came in on the URL: remember it so the phone never needs it again.
      if (url.searchParams.has('k')) res.setHeader('set-cookie', codeCookie());
    }
    if (p === '/api/state') return json(res, 200, buildState());
    if (p === '/api/toolbox') return json(res, 200, toolbox());
    if (p === '/api/usage') return json(res, 200, usage());
    if (p === '/api/providers') return json(res, 200, providersPayload());
    // Method-guarded: this path also takes a POST, and the read would otherwise swallow it.
    if (p === '/api/prefs' && req.method === 'GET') return json(res, 200, prefs);
    if (p === '/api/provider-keys' && req.method === 'GET') return json(res, 200, providerKeysPublic());

    /* The write token is minted per server run and injected into the page once, so a tab that was
       open across a restart holds a stale one and every write fails with "bad token". This lets it
       pick up the current one. It does not weaken the CSRF guard: a cross-origin page can issue
       this GET but the browser will not let it read the response, which is the whole point. */
    if (p === '/api/token' && req.method === 'GET') return json(res, 200, { token: TOKEN });
    if (p === '/api/trash') return json(res, 200, { versions: trashVersions(), keep: TRASH_KEEP });

    if (p === '/api/search') {
      const asked = Number(url.searchParams.get('limit') || 40);
      return json(res, 200, searchTranscripts(url.searchParams.get('q'), {
        limit: Number.isFinite(asked) ? Math.min(200, Math.max(1, Math.floor(asked))) : 40,
      }));
    }

    if (p === '/api/export') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad id' });
      const md = exportMarkdown(id);
      if (!md) return json(res, 404, { error: 'no transcript for that session' });
      const buf = Buffer.from(md, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': buf.length,
        'content-disposition': `attachment; filename="chat-${id.slice(0, 8)}.md"`,
        'cache-control': 'no-store',
      });
      return res.end(buf);
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hello\n\n');
      res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
      sseClients.add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
      req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
      return;
    }

    if (p === '/api/image') {
      const id = url.searchParams.get('id') || '';
      const uuid = url.searchParams.get('uuid') || '';
      const bi = Number(url.searchParams.get('b'));
      if (!/^[0-9a-fA-F-]{8,64}$/.test(id) || !/^[0-9a-fA-F-]{8,64}$/.test(uuid)
        || !Number.isInteger(bi) || bi < 0 || bi > 200) return json(res, 400, { error: 'bad image request' });
      const entry = transcriptIndex().get(id);
      if (!entry) return json(res, 404, { error: 'no transcript for that session' });
      const row = findRow(entry.file, entry.stat.size, uuid);
      const block = Array.isArray(row?.message?.content) ? row.message.content[bi] : null;
      const src = block?.type === 'image' ? block.source : null;
      // The mime type comes straight back out as a content-type header, so whitelist it.
      if (!src || src.type !== 'base64' || !IMAGE_MIME.has(src.media_type)) return json(res, 404, { error: 'no such image' });
      const buf = Buffer.from(String(src.data || ''), 'base64');
      if (!buf.length) return json(res, 404, { error: 'empty image' });
      res.writeHead(200, {
        'content-type': src.media_type,
        'content-length': buf.length,
        // A transcript row is append-only - once written it never changes.
        'cache-control': 'private, max-age=86400, immutable',
      });
      return res.end(buf);
    }

    // Live feed of one headless run. Buffered events replay first, so a page refresh mid-run
    // still catches up instead of losing the answer.
    if (p === '/api/chat/events') {
      const run = runs.get(url.searchParams.get('run') || '');
      if (!run) return json(res, 404, { error: 'no such run' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hello\n\n');
      for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (run.done) { res.end(); return; }
      run.subscribers.add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
      req.on('close', () => { clearInterval(beat); run.subscribers.delete(res); });
      return;
    }

    if (p === '/api/transcript') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad id' });
      // Clamped: an unbounded limit is a way to ask the server for an arbitrarily large response.
      const asked = Number(url.searchParams.get('limit') || 60);
      const limit = Number.isFinite(asked) ? Math.min(600, Math.max(1, Math.floor(asked))) : 60;
      const convo = readConversation(id, limit);
      return convo ? json(res, 200, convo) : json(res, 404, { error: 'no transcript for that session' });
    }

    if (req.method === 'POST') {
      if (req.headers['x-fleet-token'] !== TOKEN) return json(res, 403, { error: 'bad token' });
      // Pasted screenshots arrive base64-inlined, so the reply route needs real headroom.
      const body = await readBody(req, p === '/api/reply' ? 64 * 1024 * 1024 : 256 * 1024);

      if (p === '/api/reply') {
        const id = String(body.id || '');
        if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad id' });
        const info = launchTerminal({ id, cwd: body.cwd, message: body.message, images: body.images, model: body.model, effort: body.effort });
        return json(res, 200, { ok: true, ...info });
      }

      // Open a terminal on a brand new chat rather than resuming one.
      if (p === '/api/new-terminal') {
        const info = launchTerminal({ cwd: body.cwd, message: body.message, images: body.images, model: body.model, effort: body.effort });
        return json(res, 200, { ok: true, ...info });
      }

      // Run it headless and stream it into the page - no terminal at all.
      if (p === '/api/chat') {
        const id = body.id ? String(body.id) : null;
        if (id && !/^[0-9a-fA-F-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad id' });
        // An existing id's provider is resolved from the server's own local index, never trusted
        // from the client - so a stale or malicious `provider` can't redirect an existing
        // session's resume into the wrong path. Only a brand-new chat's `provider` is honoured.
        const provider = id ? (openaiHas(id) ? 'openai' : 'claude') : (body.provider === 'openai' ? 'openai' : 'claude');
        const info = provider === 'openai'
          ? startOpenAIChatRun({ id, message: body.message, images: body.images, model: body.model })
          : startChat({
              id, cwd: String(body.cwd || ''), message: body.message, images: body.images,
              model: body.model, effort: body.effort, stance: body.stance,
              fromThisPc: fromThisMachine(req),
            });
        return json(res, 200, { ok: true, provider, ...info });
      }

      // "I am done with this chat" - drops it out of the queue until the session moves again.
      if (p === '/api/idle') {
        const id = String(body.id || '');
        if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad id' });
        if (body.idle === false) idleMarks.delete(id);
        else idleMarks.set(id, Date.now());
        saveIdleMarks();
        tick(); // repaint every open board now rather than on the next poll
        return json(res, 200, { ok: true, idle: idleMarks.has(id) });
      }

      /* --- editing rules, skills and MCP servers --- */

      if (p === '/api/file/read') {
        const file = resolveEditable(body.file);
        return json(res, 200, { ok: true, file, text: fs.readFileSync(file, 'utf8') });
      }

      if (p === '/api/file/write') {
        const file = resolveEditable(body.file);
        if (typeof body.text !== 'string') return json(res, 400, { error: 'no text' });
        if (body.text.length > 2 * 1024 * 1024) return json(res, 400, { error: 'that is too big to be one of these files' });
        const backup = toTrash(file);
        writeAtomic(file, body.text);
        return json(res, 200, { ok: true, file, backup });
      }

      if (p === '/api/file/delete') {
        const file = resolveEditable(body.file);
        if (path.normalize(file).toLowerCase() === path.normalize(CLAUDE_JSON).toLowerCase()) {
          return json(res, 400, { error: 'not that one — it holds your account and every project record' });
        }
        const backup = toTrash(file);
        fs.rmSync(file);
        toolboxCache = { at: 0, data: null };
        return json(res, 200, { ok: true, file, backup });
      }

      if (p === '/api/file/create') {
        const file = newFilePath(body);
        if (fs.existsSync(file)) return json(res, 409, { error: 'that already exists' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const template = (TEMPLATES[body.kind] || (() => ''))(String(body.name || '').trim());
        fs.writeFileSync(file, template, 'utf8');
        toolboxCache = { at: 0, data: null };
        return json(res, 200, { ok: true, file, text: template });
      }

      if (p === '/api/prefs') return json(res, 200, { ok: true, prefs: savePrefs(body.patch) });

      if (p === '/api/provider-keys') {
        const provider = String(body.provider || '');
        if (provider !== 'openai') return json(res, 400, { error: 'unknown provider' });
        const { backup } = saveProviderKey(provider, body.key);
        return json(res, 200, { ok: true, provider, backup });
      }
      if (p === '/api/provider-keys/delete') {
        const provider = String(body.provider || '');
        deleteProviderKey(provider);
        return json(res, 200, { ok: true, provider });
      }
      if (p === '/api/provider-keys/test') {
        const provider = String(body.provider || '');
        if (provider !== 'openai') return json(res, 400, { error: 'unknown provider' });
        // Tests whatever was just typed, not necessarily the saved key - so "Test" works before "Save".
        const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : getOpenAIKey();
        const result = await testOpenAIKey(key);
        return json(res, 200, result);
      }

      if (p === '/api/trash/read') return json(res, 200, { ok: true, name: body.name, text: readTrashVersion(body.name) });
      if (p === '/api/trash/empty') return json(res, 200, { ok: true, removed: emptyTrash() });
      if (p === '/api/trash/restore') {
        const file = resolveEditable(body.file);
        const text = readTrashVersion(body.name);
        toTrash(file);                    // the current contents become a version too
        writeAtomic(file, text);
        return json(res, 200, { ok: true, file, from: body.name });
      }

      if (p === '/api/hook') return json(res, 200, { ok: true, ...editHook(body) });

      if (p === '/api/chat/forget') {
        const id = String(body.id || '');
        // For Claude this only unpins the card - the transcript lives on independently on disk.
        if (inPageChats.has(id)) {
          inPageChats.delete(id);
          try { fs.writeFileSync(CHATS_FILE, JSON.stringify({ chats: [...inPageChats.values()] }, null, 2), 'utf8'); } catch {}
          return json(res, 200, { ok: true, id, note: 'the transcript itself is untouched' });
        }
        // For OpenAI the local file *is* the only copy, so "forget" here only unpins it from the
        // board too - the file survives until /api/chat/delete removes it for good.
        if (openaiHas(id) && openaiUnpin(id)) {
          return json(res, 200, { ok: true, id, note: 'kept — use delete to remove it for good' });
        }
        return json(res, 404, { error: 'not a chat this app started' });
      }

      // OpenAI-only: unlike Claude's forget, this actually removes the local copy - it's the
      // only one that ever existed.
      if (p === '/api/chat/delete') {
        const id = String(body.id || '');
        if (!openaiHas(id)) return json(res, 404, { error: 'no such chat' });
        openaiDelete(id);
        return json(res, 200, { ok: true, id });
      }

      if (p === '/api/mcp/save') return json(res, 200, { ok: true, ...saveMcpServer(body) });
      if (p === '/api/mcp/delete') return json(res, 200, { ok: true, ...deleteMcpServer(body) });
      if (p === '/api/permission') return json(res, 200, { ok: true, ...editPermission(body) });

      if (p === '/api/chat/stop') {
        const run = runs.get(String(body.run || ''));
        if (!run) return json(res, 404, { error: 'no such run' });
        try { run.stop?.(); } catch { /* already gone */ }
        return json(res, 200, { ok: true });
      }
      if (p === '/api/open') return json(res, 200, { ok: true, ...openTarget(body) });
      return json(res, 404, { error: 'no such action' });
    }

    // static files
    let file = p === '/' ? 'index.html' : p === '/pair' ? 'pair.html' : p.replace(/^\/+/, '');
    if (file.includes('..')) return json(res, 400, { error: 'nope' });
    const full = path.join(PUBLIC_DIR, file);
    let data;
    try { data = await fsp.readFile(full); } catch { res.writeHead(404).end('not found'); return; }
    if (file === 'index.html' || file === 'pair.html') {
      // Only ever handed to an already-authorised client, so the pairing URL can ride along.
      const phone = LAN
        ? JSON.stringify({ code: ACCESS, urls: lanAddresses().map((ip) => `http://${ip}:${PORT}/?k=${ACCESS}`) })
        : 'null';
      // Injected rather than fetched: the front end reads its settings synchronously at start-up,
      // so an async round trip would paint the defaults first and then jump.
      data = Buffer.from(data.toString('utf8')
        .replace('__FLEET_TOKEN__', TOKEN)
        .replace('__FLEET_PHONE__', phone)
        .replace('__FLEET_PREFS__', JSON.stringify(prefs))
        .replace('__FLEET_LOOPBACK__', String(fromThisMachine(req))));
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  setInterval(tick, POLL_MS).unref?.();
  const url = `http://localhost:${PORT}/`;
  console.log(`Rals Cockpit  ->  ${url}`);
  console.log(`watching      ->  ${CLAUDE_DIR}`);
  if (LAN) {
    const ips = lanAddresses();
    console.log('');
    console.log('  phone access is ON - this port is open to your local network');
    for (const ip of ips) console.log(`  on your phone ->  http://${ip}:${PORT}/?k=${ACCESS}`);
    if (!ips.length) console.log('  (no LAN address found - are you connected to a network?)');
    console.log(`  access code   ->  ${ACCESS}   (asked once per device)`);
    console.log('  Same Wi-Fi only. Do not port-forward this, and do not run it on a network you');
    console.log('  do not trust: anyone with the code can open terminals on this machine.');
    console.log('');
  }
  if (process.env.FLEET_NO_OPEN !== '1') {
    const child = spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use - Rals Cockpit may already be running at http://localhost:${PORT}/`);
    process.exit(1);
  }
  throw e;
});
