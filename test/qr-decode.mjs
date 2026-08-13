/* A QR decoder, used only by the tests.
 *
 * public/qr.js writes QR codes and nothing on this machine can read one back — no BarcodeDetector
 * in the browser, no library on disk. So the encoder is checked against test/fixtures-qr.json, a
 * real QR produced by a different implementation. Reading that fixture back to its original URL is
 * what makes this decoder trustworthy: if the traversal or the field arithmetic were wrong, a
 * stranger's QR would come out as noise, not as an address.
 *
 * No error correction — the fixture and our own output are both clean, and a decoder that silently
 * repairs damage would hide exactly the bugs this is here to catch.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const BLOCKS = {
  L: { 1: [7, 1, 19, 0, 0], 2: [10, 1, 34, 0, 0], 3: [15, 1, 55, 0, 0], 4: [20, 1, 80, 0, 0], 5: [26, 1, 108, 0, 0], 6: [18, 2, 68, 0, 0] },
  M: { 1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0] },
  Q: { 1: [13, 1, 13, 0, 0], 2: [22, 1, 22, 0, 0], 3: [18, 2, 17, 0, 0], 4: [26, 2, 24, 0, 0], 5: [18, 2, 15, 2, 16], 6: [24, 4, 19, 0, 0] },
  H: { 1: [17, 1, 9, 0, 0], 2: [28, 1, 16, 0, 0], 3: [22, 2, 13, 0, 0], 4: [16, 4, 9, 0, 0], 5: [22, 2, 11, 2, 12], 6: [28, 4, 15, 0, 0] },
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
const LEVEL_OF = { 0b01: 'L', 0b00: 'M', 0b11: 'Q', 0b10: 'H' };

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function functionMap(version, n) {
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < n && y < n) fixed[y][x] = true; };
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  for (let i = 0; i < n; i++) { mark(i, 6); mark(6, i); }
  for (const cy of ALIGN[version]) for (const cx of ALIGN[version]) {
    const nearFinder = (cx < 9 && cy < 9) || (cx < 9 && cy > n - 10) || (cx > n - 10 && cy < 9);
    if (nearFinder) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy);
  }
  for (let i = 0; i < 9; i++) { mark(i, 8); mark(8, i); }
  for (let i = 0; i < 8; i++) { mark(n - 1 - i, 8); mark(8, n - 1 - i); }
  return fixed;
}

/* The format area is written twice. Read the copy by the top-left finder, undo the mask that is
   applied to it, and brute-force the nearest of the 32 legal values — that is how a real scanner
   tolerates a smudge, and here it also tells us when a grid is not a QR code at all. */
function readFormat(g, n) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits.push(g[8][i]);
  bits.push(g[8][7], g[8][8], g[7][8]);
  for (let i = 9; i <= 14; i++) bits.push(g[14 - i][8]);
  const raw = bits.reduce((v, b) => (v << 1) | b, 0) ^ 0b101010000010010;

  let best = null;
  for (let value = 0; value < 32; value++) {
    let rem = value << 10;
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
    const candidate = (value << 10) | rem;
    let dist = 0;
    for (let i = 0; i < 15; i++) if (((candidate >> i) & 1) !== ((raw >> i) & 1)) dist++;
    if (!best || dist < best.dist) best = { dist, value };
  }
  if (best.dist > 3) throw new Error('no readable format information');
  return { level: LEVEL_OF[best.value >> 3], mask: best.value & 0b111, distance: best.dist };
}

/** decode({size, rows}) -> {text, level, mask, version} */
export function decode({ size, rows }) {
  const n = size;
  const version = (n - 17) / 4;
  if (!Number.isInteger(version) || !ALIGN[version]) throw new Error(`unsupported size ${n}`);

  const g = rows.map((r) => (typeof r === 'string' ? [...r].map(Number) : r.slice()));
  const { level, mask, distance } = readFormat(g, n);
  const fixed = functionMap(version, n);
  const un = g.map((row, y) => row.map((v, x) => (fixed[y][x] ? v : (MASKS[mask](x, y) ? v ^ 1 : v))));

  const bits = [];
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < n; step++) {
      const y = upward ? n - 1 - step : step;
      for (const x of [right, right - 1]) if (!fixed[y][x]) bits.push(un[y][x]);
    }
    upward = !upward;
  }

  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  // Undo the interleave: data codewords first, column by column across the blocks.
  const [ecPerBlock, b1, d1, b2, d2] = BLOCKS[level][version];
  const sizes = [...Array(b1).fill(d1), ...Array(b2).fill(d2)];
  const blocks = sizes.map(() => []);
  let at = 0;
  const widest = Math.max(...sizes);
  for (let i = 0; i < widest; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < sizes[b]) blocks[b].push(words[at++]);
  }
  const data = blocks.flat();

  let bit = 0;
  const dataBits = [];
  for (const w of data) for (let i = 7; i >= 0; i--) dataBits.push((w >> i) & 1);
  const take = (count) => { let v = 0; for (let i = 0; i < count; i++) v = (v << 1) | (dataBits[bit++] || 0); return v; };

  /* A QR payload is a sequence of segments, each with its own mode — a good encoder switches mode
     mid-string to save space, which is why the reference splits a URL into a byte segment for
     "http" and an alphanumeric one for "://192.168.0.96:4200/". All four data modes are read here
     so a foreign code comes back whole. */
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const segments = [];
  let text = '';
  while (bit + 4 <= dataBits.length) {
    const mode = take(4);
    if (mode === 0b0000) break;                                  // terminator
    if (mode === 0b0001) {                                       // numeric, three digits per 10 bits
      const count = take(10);
      let out = '';
      for (let left = count; left > 0; left -= 3) {
        const n = Math.min(3, left);
        out += String(take([0, 4, 7, 10][n])).padStart(n, '0');
      }
      segments.push({ mode: 'numeric', count }); text += out;
    } else if (mode === 0b0010) {                                // alphanumeric, two chars per 11 bits
      const count = take(9);
      let out = '';
      for (let left = count; left > 0; left -= 2) {
        if (left >= 2) { const v = take(11); out += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; }
        else out += ALNUM[take(6)];
      }
      segments.push({ mode: 'alphanumeric', count }); text += out;
    } else if (mode === 0b0100) {                                // byte
      const count = take(8);
      const bytes = [];
      for (let i = 0; i < count; i++) bytes.push(take(8));
      segments.push({ mode: 'byte', count });
      text += new TextDecoder().decode(Uint8Array.from(bytes));
    } else {
      throw new Error(`unhandled mode ${mode.toString(2).padStart(4, '0')}`);
    }
  }

  return { text, level, mask, version, ecPerBlock, formatDistance: distance, segments, data, words };
}
