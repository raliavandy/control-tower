#!/usr/bin/env node
/* Control Tower test runner.
 *
 *   node test/run.mjs                 # everything
 *   node test/run.mjs guards          # only suites whose name or file matches "guards"
 *   TEST_PORT=8123 node test/run.mjs  # somewhere else
 *
 * It starts its own server on a spare port with FLEET_DRY_RUN=1, so nothing in here can open a
 * terminal, and points every check at that rather than whatever you have running.
 *
 * The browser suite needs Playwright and says so if it cannot find it. The API suites need
 * nothing, and they are the ones guarding the paths that write to your config.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, ROOT, state, results, record, get } from './harness.mjs';

state.port = Number(process.env.TEST_PORT || 7999);
state.only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let child = null;

async function startServer() {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLEET_PORT: String(state.port),
      FLEET_NO_OPEN: '1',
      FLEET_DRY_RUN: '1',
      // A scratch prefs file, so a test run never rearranges your real dashboard.
      FLEET_PREFS_FILE: path.join(os.tmpdir(), `control-tower-test-prefs-${process.pid}.json`),
      // Same idea for provider keys - a test run must never read or overwrite a real saved key.
      FLEET_PROVIDER_KEYS_FILE: path.join(os.tmpdir(), `control-tower-test-provider-keys-${process.pid}.json`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stdout.resume();                      // drain, or a chatty child blocks on a full pipe
  child.stderr.on('data', (c) => { err += c; });
  child.on('error', (e) => { err += e.message; });

  for (let i = 0; i < 75; i++) {
    try {
      const res = await get('/');
      if (res.status === 200) {
        state.token = /window\.FLEET_TOKEN = "([^"]+)"/.exec(res.body)?.[1] || '';
        process.stdout.write(`server up on :${state.port} (dry run — no terminals can open)\n`);
        return;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the test server never came up on :${state.port}\n${err}`);
}

const SUITES = ['api-guards.mjs', 'api-shape.mjs', 'qr.mjs', 'ui.mjs'];

await startServer();
try {
  for (const file of SUITES) {
    state.file = file;
    // pathToFileURL, not concatenation: on Windows "file://" + "C:\..." is a malformed URL.
    await import(pathToFileURL(path.join(HERE, file)).href);
  }
} catch (e) {
  record(false, `${state.file} failed to load`, e.stack?.split('\n').slice(0, 3).join('\n        ') || e.message);
} finally {
  child?.kill();
}

const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write(`\n\x1b[31m${failed.length} failed:\x1b[0m\n`);
  for (const f of failed) process.stdout.write(`  ${f.suite} — ${f.what}\n`);
}
process.exit(failed.length ? 1 : 0);
