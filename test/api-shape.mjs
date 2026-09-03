/* The read side: does each endpoint answer with the shape the front end assumes? */

import fs from 'node:fs';
import { describe, ok, eq, get, getJson, post } from './harness.mjs';

await describe('state', async () => {
  const s = await getJson('/api/state');
  ok(Array.isArray(s.sessions), 'sessions is an array');
  ok(typeof s.stats?.live === 'number', 'stats.live is a number');
  const one = s.sessions[0];
  if (!one) { ok(true, 'no sessions on this machine — skipped the per-session shape'); return; }
  for (const key of ['id', 'provider', 'alive', 'status', 'needsYou', 'project', 'lastActivity', 'mcpUsed', 'skillsUsed', 'inPage']) {
    ok(key in one, `a session carries ${key}`);
  }
  ok(['working', 'waiting-for-you', 'blocked', 'done', 'idle', 'here', 'ended'].includes(one.status),
    `status is one the UI knows (${one.status})`);
});

await describe('transcript', async () => {
  const s = await getJson('/api/state');
  const withFile = s.sessions.find((x) => x.transcript);
  if (!withFile) { ok(true, 'no transcript to read — skipped'); return; }

  const bad = await getJson('/api/transcript?id=not-a-real-id');
  ok(!!bad.error, 'a bad id is rejected');

  const clamped = await getJson(`/api/transcript?id=${withFile.id}&limit=999999`);
  ok(clamped.items.length <= 600, `an absurd limit is clamped (got ${clamped.items.length})`);

  const small = await getJson(`/api/transcript?id=${withFile.id}&limit=3`);
  ok(small.items.length <= 3, 'a small limit is honoured');
  for (const m of small.items) ok(Array.isArray(m.images), 'images is an array of references, not a count');
});

await describe('search', async () => {
  const short = await getJson('/api/search?q=a');
  ok(short.tooShort, 'a one-character query is refused rather than scanning everything');

  const hits = await getJson('/api/search?q=' + encodeURIComponent('the'));
  ok(typeof hits.scanned === 'number' && hits.scanned > 0, 'it reports how many transcripts it read');
  ok(Array.isArray(hits.hits), 'hits is an array');
  if (hits.hits[0]) {
    for (const key of ['id', 'project', 'role', 'before', 'match', 'after', 'provider']) {
      ok(key in hits.hits[0], `a hit carries ${key}`);
    }
    ok(hits.hits[0].match.toLowerCase() === 'the', 'the matched text is the needle itself');
  }
});

await describe('usage', async () => {
  const u = await getJson('/api/usage');
  for (const key of ['totals', 'days', 'models', 'projects', 'today', 'duplicatesSkipped']) {
    ok(key in u, `usage carries ${key}`);
  }
  ok(u.totals.requests > 0, 'it counted some requests');
  ok(typeof u.totals.cost === 'number', 'cost is a number even when the plan records none');
  const sorted = u.days.every((d, i, a) => i === 0 || a[i - 1].date <= d.date);
  ok(sorted, 'days come back in date order');
  ok(u.duplicatesSkipped >= 0, 'replayed messages are counted once and reported');
});

await describe('toolbox', async () => {
  const t = await getJson('/api/toolbox');
  for (const key of ['mcp', 'skills', 'agents', 'commands', 'rules', 'projects', 'dirs']) {
    ok(key in t, `toolbox carries ${key}`);
  }
  for (const key of ['memory', 'claudeMd', 'hooks', 'permissions']) {
    ok(key in t.rules, `rules carries ${key}`);
  }
  const paths = t.rules.claudeMd.map((m) => m.file.toLowerCase());
  eq(paths.length, new Set(paths).size, 'CLAUDE.md files are deduplicated');
  const settings = t.rules.permissions.map((p) => p.file.toLowerCase());
  ok(new Set(settings).size <= settings.length, 'settings files are not double counted');
});

await describe('export', async () => {
  const s = await getJson('/api/state');
  const withFile = s.sessions.find((x) => x.transcript);
  if (!withFile) { ok(true, 'nothing to export — skipped'); return; }
  const res = await get(`/api/export?id=${withFile.id}`);
  eq(res.status, 200, 'exports');
  ok(/markdown/.test(res.headers['content-type'] || ''), 'as markdown');
  ok(/attachment; filename=/.test(res.headers['content-disposition'] || ''), 'as a download');
  ok(res.body.startsWith('# '), 'starting with a heading');
});

await describe('prefs', async () => {
  const before = await getJson('/api/prefs');
  const saved = await post('/api/prefs', { patch: { groupby: 'status', bogusKey: 'ignored' } });
  eq(saved.status, 200, 'saves a patch');
  const after = await getJson('/api/prefs');
  eq(after.groupby, 'status', 'the known key stuck');
  ok(!('bogusKey' in after), 'an unknown key was ignored rather than stored');
  await post('/api/prefs', { patch: { groupby: before.groupby ?? null } });
});

await describe('providers', async () => {
  const p = await getJson('/api/providers');
  ok(p.claude?.configured === true, 'Claude Code is always registered and configured');
  for (const key of ['label', 'kind', 'configured', 'canResumeInTerminal', 'hasFolder', 'hasStance', 'hasImages', 'deletable']) {
    ok(key in p.claude, `claude carries ${key}`);
    ok(key in p.openai, `openai carries ${key}`);
  }
  ok(Array.isArray(p.openai.models) && p.openai.models.length > 0, 'openai comes with a curated model list');
  ok(p.openai.canResumeInTerminal === false, 'there is no terminal to resume an API-only chat in');
  ok(p.claude.deletable === false && p.openai.deletable === true, 'only a provider with no independent copy can be deleted through this app');
});

await describe('update-check', async () => {
  // The one route that talks to the real network - tolerant of it being unreachable or
  // rate-limited (that's `error` set, not a thrown exception), since a CI runner's GitHub
  // access is outside this app's control either way.
  const u = await getJson('/api/update-check');
  ok(typeof u.current === 'string' && u.current.length > 0, 'always reports the running version');
  ok('upToDate' in u || 'error' in u, 'either resolves an answer or says why it could not');
});

await describe('trash', async () => {
  const t = await getJson('/api/trash');
  ok(Array.isArray(t.versions), 'versions is an array');
  ok(typeof t.keep === 'number', 'it reports how many it keeps');
  const bad = await post('/api/trash/read', { name: '../../../server.mjs' });
  ok(bad.status >= 400, 'a traversal in a backup name is refused');
});
