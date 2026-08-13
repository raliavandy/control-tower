/* The suite that matters most: everything this app must refuse.
   These write to files that decide what Claude may do without asking, so each refusal is a
   guard rail, not a nicety. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, ok, eq, get, getJson, post } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

await describe('write guards — paths it must refuse', async () => {
  const tb = await getJson('/api/toolbox');

  const outside = await post('/api/file/write', { file: 'C:/Windows/System32/drivers/etc/hosts', text: 'nope' });
  ok(outside.status >= 400, 'refuses a path it never published', `got ${outside.status}`);

  const traversal = await post('/api/file/write', { file: '../../../../Windows/win.ini', text: 'nope' });
  ok(traversal.status >= 400, 'refuses a traversal', `got ${traversal.status}`);

  const marketplace = tb.skills.find((s) => s.scope === 'marketplace');
  if (marketplace) {
    const r = await post('/api/file/write', { file: marketplace.file, text: 'nope' });
    ok(r.status >= 400, 'refuses a marketplace plugin copy', `got ${r.status}`);
  }

  const nuke = await post('/api/file/delete', { file: tb.dirs.config });
  ok(nuke.status >= 400, 'refuses to delete ~/.claude.json', `got ${nuke.status}`);

  const badName = await post('/api/file/create', { kind: 'skill', scope: 'user', name: '../evil' });
  ok(badName.status >= 400, 'refuses a new-file name with a traversal in it', `got ${badName.status}`);

  const noToken = await new Promise((resolve) => {
    const data = JSON.stringify({ file: 'x', text: 'y' });
    const req = http.request({
      host: '127.0.0.1', port: Number(process.env.TEST_PORT || 7999), path: '/api/file/write', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.write(data); req.end();
  });
  ok(noToken === 403, 'a POST without the run token is rejected', `got ${noToken}`);
});

await describe('write guards — MCP definitions are validated', async () => {
  const noCommand = await post('/api/mcp/save', { scope: 'user', name: 'test-broken', transport: 'stdio' });
  ok(noCommand.status >= 400, 'a stdio server without a command is refused');

  const badUrl = await post('/api/mcp/save', { scope: 'user', name: 'test-broken', transport: 'http', url: 'not-a-url' });
  ok(badUrl.status >= 400, 'an http server without an http(s) URL is refused');

  const badName = await post('/api/mcp/save', { scope: 'user', name: 'has spaces', transport: 'stdio', command: 'x' });
  ok(badName.status >= 400, 'a server name with spaces is refused');
});

await describe('write guards — a bad edit never lands', async () => {
  const tb = await getJson('/api/toolbox');
  const settings = tb.rules.permissions[0]?.file;
  if (!settings) { ok(true, 'no settings file to test against — skipped'); return; }
  const before = fs.readFileSync(settings, 'utf8');
  const r = await post('/api/file/write', { file: settings, text: '{ this is not json' });
  ok(r.status >= 400, 'invalid JSON is refused for a .json file');
  eq(fs.readFileSync(settings, 'utf8'), before, 'and the file on disk is untouched');
});

await describe('write guards — the bypass stance is loopback only', async () => {
  // The test client IS loopback, so this asserts the loopback case is allowed through and
  // documents where the check lives; the network case is covered by reading the guard.
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8').replace(/\r/g, '');
  ok(/stance === 'full' && !fromThisPc/.test(src), 'startChat refuses the no-prompts stance off-machine');
  ok(/fromThisPc: fromThisMachine\(req\)/.test(src), 'and the route decides that from the socket, not a header');
});

await describe('round trip — an MCP server survives being saved unchanged', async () => {
  const tb = await getJson('/api/toolbox');
  const home = os.homedir();
  const cfgPath = path.join(home, '.claude.json');
  const row = tb.mcp.find((m) => m.scope === 'user' && m.def && m.def.command);
  if (!row) { ok(true, 'no user-scope stdio server to test — skipped'); return; }

  const before = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(!!row.def, 'the inventory carries the real definition, not just a display string');
  eq(row.def.command, before.mcpServers[row.name].command, 'command matches disk');
  eq(row.def.args, before.mcpServers[row.name].args || [], 'args match disk');

  const saved = await post('/api/mcp/save', {
    scope: 'user', name: row.name, originalName: row.name, transport: 'stdio',
    command: row.def.command,
    args: (row.def.args || []).join('\n'),
    env: Object.entries(row.def.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  });
  ok(saved.status === 200, 'saving it back succeeds');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  eq(after.mcpServers[row.name], before.mcpServers[row.name], 'the definition is byte-identical after a no-op save');
  eq(Object.keys(after).length, Object.keys(before).length, 'no other key in ~/.claude.json was touched');
  eq(after.oauthAccount, before.oauthAccount, 'the account block is intact');
});

await describe('round trip — an argument containing a space survives', async () => {
  const name = 'test-spaced-args';
  const args = ['/c', 'echo', 'hello world', '--flag=a b'];
  const save = await post('/api/mcp/save', {
    scope: 'user', name, transport: 'stdio', command: 'cmd', args: args.join('\n'),
  });
  ok(save.status === 200, 'saves');
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  eq(cfg.mcpServers[name].args, args, 'each argument came back whole');
  const gone = await post('/api/mcp/delete', { scope: 'user', name });
  ok(gone.status === 200, 'and it cleans up after itself');
});
