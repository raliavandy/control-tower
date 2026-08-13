/* public/qr.js — is the QR it draws actually a QR?
 *
 * Nothing on this machine can read a QR code: no BarcodeDetector in the browser, no library on
 * disk. So the ground truth is test/fixtures-qr.json — two real codes produced by a different
 * implementation, lifted out of a page that was generated elsewhere. Three things get checked
 * against them, in the order a scanner would meet them:
 *
 *   1. test/qr-decode.mjs reads both foreign codes back to their exact URLs. That is what earns the
 *      decoder its keep — traversal, mask, format bits and de-interleave all have to be right for a
 *      stranger's code to come out as an address rather than as noise.
 *   2. Our Reed-Solomon, run over the foreign code's own data codewords, reproduces its error
 *      correction bytes exactly. Wrong field arithmetic passes step 1 and fails a real scanner.
 *   3. Whatever the encoder writes, the decoder reads back unchanged.
 *
 * The foreign codes will not match ours module for module and are not expected to: that generator
 * splits a URL into a byte segment and an alphanumeric one, which is smaller than our plain byte
 * mode. Both are valid QR codes for the same text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, ok, eq, HERE, ROOT } from './harness.mjs';
import { decode } from './qr-decode.mjs';

const require = createRequire(import.meta.url);
const QR = require(path.join(ROOT, 'public', 'qr.js'));
const FIXTURES = ['fixtures-qr.json', 'fixtures-qr-b.json']
  .map((f) => path.join(HERE, f))
  .filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

await describe('qr: reading a code from another implementation', async () => {
  ok(FIXTURES.length >= 2, `${FIXTURES.length} reference codes on hand`);
  for (const fix of FIXTURES) {
    const got = decode(fix);
    eq(got.text, fix.text, `the reference code for ${fix.text} reads back exactly`);
    eq(got.formatDistance, 0, 'its format information is clean, not repaired');
    eq(got.level, fix.level, `its correction level reads as ${fix.level}`);
    eq(got.mask, fix.mask, `its mask reads as ${fix.mask}`);
  }
  const masks = new Set(FIXTURES.map((f) => f.mask));
  ok(masks.size > 1, `the references use different masks (${[...masks].join(', ')}), so the mask path is exercised`);
});

await describe('qr: error correction against the reference bytes', async () => {
  for (const fix of FIXTURES) {
    const got = decode(fix);
    const dataCount = got.data.length;
    const theirs = got.words.slice(dataCount, dataCount + got.ecPerBlock);
    const ours = QR.ecc(got.data, got.ecPerBlock);
    eq(ours.join(','), theirs.join(','),
      `our ${got.ecPerBlock} correction bytes match the reference's for ${fix.text}`);
  }
});

await describe('qr: round trip', async () => {
  const cases = [
    'http://192.168.0.96:7457/?k=A1B2C3D4',                    // the real thing
    'http://10.150.52.24:7457/?k=zzzz0000',
    'a',                                                        // shortest useful
    'https://example.test/' + 'x'.repeat(40),                   // pushes to a later version
    'café — naïve',                              // multi-byte utf-8
  ];
  for (const text of cases) {
    const made = QR.encode(text);
    const read = decode({ size: made.size, rows: made.rows });
    eq(read.text, text, `round trips: ${text.length > 28 ? text.slice(0, 25) + '...' : text}`);
    eq(read.level, made.level, `  level survives (${made.level})`);
    eq(read.mask, made.mask, `  mask survives (${made.mask})`);
  }
  for (const level of ['L', 'M', 'Q', 'H']) {
    const text = 'http://192.168.0.96:7457/?k=A1B2C3D4';
    const made = QR.encode(text, { level });
    eq(decode({ size: made.size, rows: made.rows }).text, text, `round trips at level ${level}`);
  }
});

await describe('qr: the grid itself', async () => {
  const made = QR.encode('http://192.168.0.96:7457/?k=A1B2C3D4');
  eq(made.size, made.version * 4 + 17, `size matches the version (v${made.version}, ${made.size} modules)`);
  const n = made.size;
  const finder = (cx, cy) => [-4, -3, -2, -1, 0, 1, 2, 3, 4]
    .every((dy) => [-4, -3, -2, -1, 0, 1, 2, 3, 4].every((dx) => {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) return true;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      return made.rows[y][x] === (d !== 2 && d <= 3 ? 1 : 0);
    }));
  ok(finder(3, 3), 'the top-left finder pattern is exact');
  ok(finder(n - 4, 3), 'the top-right finder pattern is exact');
  ok(finder(3, n - 4), 'the bottom-left finder pattern is exact');
  ok(made.rows.every((r) => r.length === n) && made.rows.length === n, 'the grid is square');
  ok(made.rows.flat().every((v) => v === 0 || v === 1), 'every module is 0 or 1');

  const dark = made.rows.flat().reduce((a, b) => a + b, 0);
  const share = (dark / (n * n)) * 100;
  ok(share > 35 && share < 65, `dark share is balanced (${share.toFixed(1)}%)`);

  let threw = false;
  try { QR.encode('x'.repeat(400)); } catch { threw = true; }
  ok(threw, 'too much text is refused rather than silently truncated');
});
