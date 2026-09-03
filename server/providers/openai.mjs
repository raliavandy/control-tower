// The OpenAI provider. Unlike Claude Code, there is no local process and no local CLI: every
// "session" here is a JSON file this app itself created and owns. Chat Completions has no
// server-side memory, so the full message history is resent on every turn - that's the one
// piece of state this app has to carry that it doesn't for Claude.

import fs from 'node:fs';
import path from 'node:path';
import { clip, localDay, writeJsonAtomic } from '../lib/util.mjs';

export const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'];
const DEFAULT_MODEL = 'gpt-4o-mini';
const HANDBACK_MS = 10 * 60 * 1000; // mirrors server.mjs's own HANDBACK_MS for the same reason

// Published list price per 1M tokens, USD, input/output - unlike Claude on a subscription (which
// writes zero for every request), OpenAI's API genuinely is metered, so a real figure is more
// useful here than the "no cost recorded" line the rest of this app shows. Best-effort and dated:
// OpenAI's own pricing page is the source of truth if this ever looks wrong.
const OPENAI_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'o4-mini': { input: 1.10, output: 4.40 },
};

function estimateCost(model, input, output) {
  const price = OPENAI_PRICING[model];
  if (!price) return 0;
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

let CHATS_DIR = null;
export function configureOpenAI(dir) { CHATS_DIR = path.join(dir, 'openai-chats'); }

const fileFor = (id) => path.join(CHATS_DIR, `${id}.json`);

function readChat(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch { return null; }
}

function writeChat(chat) {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  writeJsonAtomic(fileFor(chat.id), chat);
  chatCache.delete(chat.id); // the file just changed under it; next read should see the new stat
}

export function openaiHas(id) {
  if (!CHATS_DIR || !id) return false;
  return fs.existsSync(fileFor(id));
}

// For deep search: every chat file this provider owns, so it can be raw-scanned for a needle the
// same way server.mjs scans Claude's own transcript files.
export function openaiChatFiles() {
  if (!CHATS_DIR) return [];
  let files = [];
  try { files = fs.readdirSync(CHATS_DIR); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => ({ id: f.slice(0, -5), file: path.join(CHATS_DIR, f) }));
}

export function openaiDelete(id) {
  chatCache.delete(id);
  try { fs.rmSync(fileFor(id), { force: true }); return true; } catch { return false; }
}

// "Forget" for an OpenAI chat can't just unpin the way Claude's does — this file is the ONLY
// copy of the conversation, so unpinning keeps the file (recoverable) while delete removes it.
export function openaiUnpin(id) {
  const chat = readChat(id);
  if (!chat) return false;
  chat.pinned = false;
  writeChat(chat);
  return true;
}

function statusFor(chat, now) {
  if (chat.streaming) return 'working';
  // Unpinned (forgotten): sinks into history like a Claude session that isn't running any more,
  // rather than vanishing outright - the only way back to it is Delete, and that needs a card.
  if (chat.pinned === false) return 'ended';
  const last = chat.messages[chat.messages.length - 1];
  if (!last) return 'here';
  // Streaming has already stopped, so a trailing user message means that turn never got a
  // reply (the request failed before any text came back) - not still "working".
  if (last.role === 'user') return 'waiting-for-you';
  const silent = now - (chat.updatedAt || 0);
  return silent > HANDBACK_MS ? 'done' : 'waiting-for-you';
}

// Reading, parsing and counting every chat's messages is the expensive part of a poll, and it
// only needs redoing when the file itself changed - mirrors server.mjs's own digestCache.
const chatCache = new Map(); // id -> { mtimeMs, size, chat, userTurns, assistantTurns }

function loadChatCached(id, stat) {
  const hit = chatCache.get(id);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const chat = readChat(id);
  if (!chat) { chatCache.delete(id); return null; }
  const entry = {
    mtimeMs: stat.mtimeMs, size: stat.size, chat,
    userTurns: chat.messages.filter((m) => m.role === 'user').length,
    assistantTurns: chat.messages.filter((m) => m.role === 'assistant').length,
  };
  chatCache.set(id, entry);
  return entry;
}

export function openaiSessions(now) {
  if (!CHATS_DIR) return [];
  let files = [];
  try { files = fs.readdirSync(CHATS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const id = f.slice(0, -5);
    let stat; try { stat = fs.statSync(path.join(CHATS_DIR, f)); } catch { continue; }
    const hit = loadChatCached(id, stat);
    if (!hit) continue;
    const { chat, userTurns, assistantTurns } = hit;
    const lastActivity = chat.updatedAt || chat.createdAt || 0;
    const last = chat.messages[chat.messages.length - 1];
    const status = statusFor(chat, now);
    out.push({
      id: chat.id,
      // Claude's own `alive` is equivalent to "not ended" (statusOf always returns 'ended' when
      // its process is gone) - matching that here, rather than the narrower "actively streaming",
      // is what makes a chat waiting on a reply show up in the needs-you queue, header count and
      // desktop notification the same way a Claude session does; those all gate on `alive`.
      alive: status !== 'ended',
      pid: null, procName: null, entrypoint: null, kind: null,
      startedAt: chat.createdAt,
      title: chat.title || (chat.messages[0]?.text ? clip(chat.messages[0].text.replace(/\s+/g, ' ').trim(), 70) : 'New chat'),
      lastPrompt: '',
      lastRole: last?.role || null,
      lastText: last?.text ? clip(last.text, 600) : '',
      status,
      idleMarked: false, // filled in by server.mjs's own idleMarks, keyed by id regardless of provider
      inPage: chat.pinned !== false,
      inPageTurns: userTurns,
      origin: null,
      spend: null,
      needsYou: status === 'waiting-for-you',
      rank: null,
      mcpUsed: {}, skillsUsed: {},
      pendingTool: null, subagentsRunning: 0, queued: 0,
      promptCount: userTurns, turnCount: assistantTurns,
      tokens: null,
      model: chat.model,
      effort: null, permissionMode: null, version: null, gitBranch: null,
      cwd: '', project: 'ChatGPT',
      transcript: fileFor(chat.id),
      lastActivity, sizeBytes: 0, truncatedWindow: false,
      provider: 'openai',
    });
  }
  return out;
}

// Same item shape server.mjs's own readConversation() returns, so the drawer and card-expand
// render this with no changes at all.
export function openaiReadConversation(id, limit = 60) {
  const chat = readChat(id);
  if (!chat) return null;
  const items = chat.messages.map((m) => ({
    role: m.role, sidechain: false, ts: m.ts || null, text: clip(m.text || '', 4000),
    tools: [], results: 0, images: [], isToolTurn: false,
  }));
  const kept = items.slice(-limit);
  return { id, title: chat.title || null, total: items.length, items: kept, file: fileFor(id) };
}

export async function testOpenAIKey(apiKey) {
  if (!apiKey) return { ok: false, error: 'no key given' };
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { ok: true };
    let msg = `OpenAI returned ${res.status}`;
    try { const j = await res.json(); if (j?.error?.message) msg = j.error.message; } catch {}
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: 'could not reach OpenAI: ' + String(e.message || e) };
  }
}

/* Streams one turn. `onEvent` receives events in the exact vocabulary server.mjs's Claude runs
   already emit (system/init, stream_event/content_block_delta/text_delta, fleet_end) - reusing
   the same /api/chat/events SSE channel and the same onChatEvent() switch on the frontend
   requires no changes there for the core streaming loop. */
export function runOpenAIChat({ id, message, model, apiKey, onEvent }) {
  const controller = new AbortController();
  const promise = streamOpenAIChat({ id, message, model, apiKey, onEvent, signal: controller.signal });
  return { promise, stop: () => controller.abort() };
}

async function streamOpenAIChat({ id, message, model, apiKey, onEvent, signal }) {
  if (!apiKey) {
    onEvent({ type: 'stderr', text: 'no OpenAI API key is saved — add one from the ⋯ menu' });
    onEvent({ type: 'fleet_end', ok: false, error: 'no API key' });
    return;
  }

  const text = String(message || '').trim();
  if (!text) { onEvent({ type: 'fleet_end', ok: false, error: 'nothing to send' }); return; }

  // The id is decided by the caller before this starts, exactly like Claude's --session-id -
  // so a brand-new chat's session id is known synchronously, not learned only after the first
  // network round trip.
  const sessionId = id;
  const now = Date.now();
  let chat = readChat(sessionId);
  if (!chat) {
    chat = { id: sessionId, title: null, model: null, project: 'ChatGPT', pinned: true, createdAt: now, updatedAt: now, messages: [], streaming: false };
  }
  const useModel = (typeof model === 'string' && model.trim()) ? model.trim() : (chat.model || DEFAULT_MODEL);
  chat.model = useModel;
  chat.messages.push({ role: 'user', text, ts: now });
  chat.streaming = true;
  chat.updatedAt = now;
  writeChat(chat);

  onEvent({ type: 'system', subtype: 'init', session_id: sessionId, cwd: '', model: useModel });

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: useModel,
        stream: true,
        stream_options: { include_usage: true },
        messages: chat.messages.map((m) => ({ role: m.role, content: m.text })),
      }),
      signal,
    });
  } catch (e) {
    chat.streaming = false; writeChat(chat);
    if (e.name === 'AbortError') { onEvent({ type: 'fleet_end', ok: false, error: 'stopped' }); return; }
    onEvent({ type: 'stderr', text: String(e.message || e) });
    onEvent({ type: 'fleet_end', ok: false, error: 'could not reach OpenAI: ' + String(e.message || e) });
    return;
  }

  if (!res.ok || !res.body) {
    let msg = `OpenAI returned ${res.status}`;
    try { const j = await res.json(); if (j?.error?.message) msg = j.error.message; } catch {}
    chat.streaming = false; writeChat(chat);
    onEvent({ type: 'stderr', text: msg });
    onEvent({ type: 'fleet_end', ok: false, error: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = null; // the final chunk (stream_options.include_usage) carries the real token count
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } });
        }
      }
    }
  } catch (e) {
    // Stop or a dropped connection still means whatever text already streamed to the browser is
    // real and was already shown - losing it from the saved transcript would make the chat file
    // silently disagree with what the user just watched arrive.
    persistTurn(chat, full, usage, useModel, text);
    if (e.name === 'AbortError') { onEvent({ type: 'fleet_end', ok: false, error: 'stopped' }); return; }
    onEvent({ type: 'stderr', text: String(e.message || e) });
    onEvent({ type: 'fleet_end', ok: false, error: 'stream interrupted: ' + String(e.message || e) });
    return;
  }

  persistTurn(chat, full, usage, useModel, text);
  onEvent({ type: 'fleet_end', ok: true, exit: 0, error: null });
}

function persistTurn(chat, full, usage, useModel, userText) {
  chat.streaming = false;
  chat.updatedAt = Date.now();
  if (full) {
    const input = usage?.prompt_tokens || 0;
    const output = usage?.completion_tokens || 0;
    chat.messages.push({
      role: 'assistant', text: full, ts: chat.updatedAt,
      usage: usage ? { input, output, cost: estimateCost(useModel, input, output) } : null,
    });
  }
  if (!chat.title) chat.title = clip(userText.replace(/\s+/g, ' ').trim(), 70);
  writeChat(chat);
}

/* Mirrors server.mjs's own usageEntries() shape exactly, so buildUsage() can bump the same
   days/models/projects/totals maps regardless of which provider an entry came from. No cache
   concept here (that's an Anthropic-specific thing), so those are always 0. */
export function openaiUsageEntries() {
  if (!CHATS_DIR) return [];
  let files = [];
  try { files = fs.readdirSync(CHATS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const id = f.slice(0, -5);
    let stat; try { stat = fs.statSync(path.join(CHATS_DIR, f)); } catch { continue; }
    const hit = loadChatCached(id, stat);
    if (!hit) continue;
    const { chat } = hit;
    for (const m of chat.messages) {
      if (m.role !== 'assistant' || !m.usage) continue;
      out.push({
        id: `${chat.id}#${m.ts}`,
        day: localDay(m.ts),
        model: chat.model || 'unknown',
        project: 'ChatGPT',
        sessionId: chat.id,
        input: m.usage.input, output: m.usage.output,
        cacheRead: 0, cacheCreate: 0,
        cost: m.usage.cost || 0,
      });
    }
  }
  return out;
}
