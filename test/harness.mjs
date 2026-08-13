/* The test harness. Deliberately free of top-level await: the suites import this and the runner
   imports the suites, so any await up here would deadlock the cycle. */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);

export const state = { port: 0, token: '', only: [], file: '', suite: '' };
export const results = [];

export async function describe(name, fn) {
  const hay = (name + ' ' + state.file).toLowerCase();
  if (state.only.length && !state.only.some((o) => hay.includes(o.toLowerCase()))) return;
  state.suite = name;
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n`);
  try { await fn(); } catch (e) { record(false, 'the suite itself threw', e.stack?.split('\n')[0] || e.message); }
}

export function record(pass, what, detail) {
  results.push({ suite: state.suite, what, pass, detail });
  const mark = pass ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  process.stdout.write(`${mark} ${what}${!pass && detail ? `\n        ${detail}` : ''}\n`);
}

export const ok = (cond, what, detail) => record(!!cond, what, detail);

export const eq = (actual, expected, what) =>
  record(JSON.stringify(actual) === JSON.stringify(expected), what,
    `expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(expected === actual ? actual : actual)}`);

export const base = () => `http://127.0.0.1:${state.port}`;

export function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: state.port, path: p }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
    }).on('error', reject);
  });
}

export const getJson = async (p) => JSON.parse((await get(p)).body);

export function post(p, body, { withToken = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    if (withToken) headers['x-fleet-token'] = state.token;
    const req = http.request({ host: '127.0.0.1', port: state.port, path: p, method: 'POST', headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: out, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function haveBrowser() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'playwright', 'index.mjs'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
