/* Control Tower — a QR encoder, so pairing a phone is a scan instead of typing an IP address and
   an eight-character code.
 *
 * Byte mode, versions 1-6, all four error-correction levels — up to 134 characters, and a pairing
 * URL is about forty. No dependency, and none of it is taken on trust: test/qr.mjs checks it against
 * two real codes made by a different implementation, reading them back to their exact URLs and
 * matching their error-correction bytes, then round-trips everything this file writes.
 *
 * It does not match those references module for module and is not meant to — that generator splits a
 * URL into a byte segment and an alphanumeric one, which is smaller than plain byte mode. Both are
 * valid codes for the same text.
 */

const QR = (() => {
  /* --- GF(256), the field Reed–Solomon works in --- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;          // the QR generator polynomial
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  // The generator polynomial for `degree` error-correction codewords.
  function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= mul(poly[j], 1);
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function ecc(data, count) {
    const gen = generator(count);
    const out = new Array(count).fill(0);
    for (const byte of data) {
      const factor = byte ^ out[0];
      out.shift();
      out.push(0);
      for (let i = 0; i < count; i++) out[i] ^= mul(gen[i + 1], factor);
    }
    return out;
  }

  /* --- per-version, per-level tables ---
     [ec codewords per block, blocks in group 1, data codewords each, blocks in group 2, data each] */
  const BLOCKS = {
    L: {
      1: [7, 1, 19, 0, 0], 2: [10, 1, 34, 0, 0], 3: [15, 1, 55, 0, 0],
      4: [20, 1, 80, 0, 0], 5: [26, 1, 108, 0, 0], 6: [18, 2, 68, 0, 0],
    },
    M: {
      1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0],
      4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0],
    },
    Q: {
      1: [13, 1, 13, 0, 0], 2: [22, 1, 22, 0, 0], 3: [18, 2, 17, 0, 0],
      4: [26, 2, 24, 0, 0], 5: [18, 2, 15, 2, 16], 6: [24, 4, 19, 0, 0],
    },
    H: {
      1: [17, 1, 9, 0, 0], 2: [28, 1, 16, 0, 0], 3: [22, 2, 13, 0, 0],
      4: [16, 4, 9, 0, 0], 5: [22, 2, 11, 2, 12], 6: [28, 4, 15, 0, 0],
    },
  };
  const LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  const capacity = (v, lvl) => {
    const [, b1, d1, b2, d2] = BLOCKS[lvl][v];
    return b1 * d1 + b2 * d2;
  };
  // What is left for the text once the mode nibble and the length byte have taken their twelve
  // bits. Choosing a version off `capacity` alone silently loses the last two characters.
  const payload = (v, lvl) => Math.floor((capacity(v, lvl) * 8 - 12) / 8);

  /* --- the data bitstream --- */
  function bitstream(bytes, version, lvl) {
    const bits = [];
    const push = (value, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    push(0b0100, 4);                                  // byte mode
    push(bytes.length, 8);                            // character count (8 bits below version 10)
    for (const b of bytes) push(b, 8);

    const total = capacity(version, lvl) * 8;
    if (bits.length > total) throw new Error('qr: the payload does not fit the chosen version');
    push(0, Math.min(4, total - bits.length));        // terminator
    while (bits.length % 8) bits.push(0);             // to a byte boundary

    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      words.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
    }
    return words;
  }

  function padTo(words, version, lvl) {
    const PAD = [0xec, 0x11];
    let i = 0;
    while (words.length < capacity(version, lvl)) words.push(PAD[i++ % 2]);
    return words;
  }

  /* --- blocks, error correction, interleaving --- */
  function codewords(bytes, version, lvl) {
    const [ecPerBlock, b1, d1, b2, d2] = BLOCKS[lvl][version];
    const data = padTo(bitstream(bytes, version, lvl), version, lvl);

    const blocks = [];
    let at = 0;
    for (let i = 0; i < b1; i++) { blocks.push(data.slice(at, at + d1)); at += d1; }
    for (let i = 0; i < b2; i++) { blocks.push(data.slice(at, at + d2)); at += d2; }
    const eccs = blocks.map((b) => ecc(b, ecPerBlock));

    const out = [];
    const widest = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < widest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecPerBlock; i++) for (const e of eccs) out.push(e[i]);
    return out;
  }

  /* --- the module grid --- */
  function build(version, words) {
    const n = version * 4 + 17;
    const grid = Array.from({ length: n }, () => new Array(n).fill(null));   // null = still free
    const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < n && y < n) grid[y][x] = dark ? 1 : 0; };

    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, d !== 2 && d <= 3);       // rings at 0..1 and 3, gap at 2
        }
      }
    };
    finder(3, 3); finder(n - 4, 3); finder(3, n - 4);

    for (let i = 8; i < n - 8; i++) {                      // timing patterns
      const dark = i % 2 === 0;
      set(i, 6, dark); set(6, i, dark);
    }

    for (const cy of ALIGN[version]) {                     // alignment patterns
      for (const cx of ALIGN[version]) {
        const nearFinder = (cx < 9 && cy < 9) || (cx < 9 && cy > n - 10) || (cx > n - 10 && cy < 9);
        if (nearFinder) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            set(cx + dx, cy + dy, d !== 1);
          }
        }
      }
    }

    set(8, n - 8, 1);                                      // the always-dark module

    // Reserve the format areas so data placement skips them.
    for (let i = 0; i < 9; i++) { if (grid[8][i] === null) set(i, 8, 0); if (grid[i][8] === null) set(8, i, 0); }
    for (let i = 0; i < 8; i++) { if (grid[8][n - 1 - i] === null) set(n - 1 - i, 8, 0); if (grid[n - 1 - i][8] === null) set(8, n - 1 - i, 0); }
    // Data, bottom-right upwards in two-column strips, boustrophedon.
    const bits = [];
    for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
    let bit = 0, upward = true;
    for (let right = n - 1; right > 0; right -= 2) {
      if (right === 6) right--;                            // the vertical timing column is skipped
      for (let step = 0; step < n; step++) {
        const y = upward ? n - 1 - step : step;
        for (const x of [right, right - 1]) {
          if (grid[y][x] !== null) continue;
          grid[y][x] = bit < bits.length ? bits[bit] : 0;
          bit++;
        }
      }
      upward = !upward;
    }
    return { grid, n };
  }

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

  // Which modules carry format/version/function data and must never be masked.
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

  /* The four penalty rules; the lowest-scoring mask is the one used. */
  function penalty(g, n) {
    let score = 0;

    const run = (get) => {
      for (let a = 0; a < n; a++) {
        let last = -1, len = 0;
        for (let b = 0; b < n; b++) {
          const v = get(a, b);
          if (v === last) { len++; if (len === 5) score += 3; else if (len > 5) score += 1; }
          else { last = v; len = 1; }
        }
      }
    };
    run((a, b) => g[a][b]);
    run((a, b) => g[b][a]);

    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const v = g[y][x];
        if (v === g[y][x + 1] && v === g[y + 1][x] && v === g[y + 1][x + 1]) score += 3;
      }
    }

    const FINDERISH = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const looks = (cells) => FINDERISH.every((v, i) => cells[i] === v);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b <= n - 11; b++) {
        const row = [], col = [];
        for (let i = 0; i < 11; i++) { row.push(g[a][b + i]); col.push(g[b + i][a]); }
        if (looks(row) || looks(row.slice().reverse())) score += 40;
        if (looks(col) || looks(col.slice().reverse())) score += 40;
      }
    }

    const dark = g.flat().reduce((s, v) => s + v, 0);
    score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return score;
  }

  /* --- format and version information --- */
  function formatBits(mask, lvl) {
    const data = (LEVEL_BITS[lvl] << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
    return ((data << 10) | rem) ^ 0b101010000010010;
  }

  /** encode(text) -> { size, rows: number[][] } — 1 is a dark module, no quiet zone included. */
  function encode(text, { level = 'M', version: want = 0, mask: wantMask = -1 } = {}) {
    const lvl = BLOCKS[level] ? level : 'M';
    const bytes = [...new TextEncoder().encode(String(text))];
    const version = want || Number(Object.keys(BLOCKS[lvl]).find((v) => bytes.length <= payload(Number(v), lvl)));
    if (!version) {
      throw new Error(`qr: ${bytes.length} bytes is too long — the limit at level ${lvl} is ${payload(6, lvl)}`);
    }

    const words = codewords(bytes, version, lvl);
    const { grid, n } = build(version, words);
    const fixed = functionMap(version, n);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      if (wantMask >= 0 && mask !== wantMask) continue;
      const candidate = grid.map((row, y) => row.map((v, x) => (fixed[y][x] ? v : (MASKS[mask](x, y) ? v ^ 1 : v))));

      /* The format word is written twice, most significant bit first — at(0) is the top bit, not
         the bottom one. The second copy is seven modules up the left of the bottom-left finder and
         eight along the row beside the top-right one; the fifteenth cell of that column belongs to
         the always-dark module, not to the format. */
      const bits = formatBits(mask, lvl);
      const at = (i) => (bits >> (14 - i)) & 1;
      for (let i = 0; i <= 5; i++) candidate[8][i] = at(i);
      candidate[8][7] = at(6); candidate[8][8] = at(7); candidate[7][8] = at(8);
      for (let i = 9; i <= 14; i++) candidate[14 - i][8] = at(i);
      for (let i = 0; i <= 6; i++) candidate[n - 1 - i][8] = at(i);
      for (let i = 7; i <= 14; i++) candidate[8][n - 15 + i] = at(i);
      candidate[n - 8][8] = 1;

      const score = penalty(candidate, n);
      if (!best || score < best.score) best = { score, rows: candidate, mask };
    }
    return { size: n, rows: best.rows, version, mask: best.mask, level: lvl };
  }

  /** An <svg> of the code, quiet zone included, sized by CSS. Passes level/version/mask to encode.
   *
   * Colours go in inline styles, not fill attributes. The app's stylesheet sets `svg { fill: none;
   * stroke: currentColor }` for its icons, and a stylesheet beats a presentation attribute — a code
   * drawn with fill attributes comes out as pale outlines that no camera will read. Inline styles
   * beat the stylesheet, so this draws the same anywhere it is dropped.
   */
  function svg(text, { quiet = 4, light = '#ffffff', dark = '#000000', ...opts } = {}) {
    const { size, rows } = encode(text, opts);
    const total = size + quiet * 2;
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', `0 0 ${total} ${total}`);
    el.setAttribute('shape-rendering', 'crispEdges');
    el.setAttribute('role', 'img');
    el.setAttribute('class', 'qr');
    el.setAttribute('aria-label', 'QR code for ' + text);
    el.setAttribute('style', 'display:block;stroke:none');

    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', total);
    bg.setAttribute('height', total);
    bg.setAttribute('class', 'qr-bg');
    bg.setAttribute('style', `fill:${light};stroke:none`);
    el.append(bg);

    // One group carrying the colour, one rect per horizontal run rather than per module.
    const mods = document.createElementNS(NS, 'g');
    mods.setAttribute('class', 'qr-mods');
    mods.setAttribute('style', `fill:${dark};stroke:none`);
    for (let y = 0; y < size; y++) {
      let x = 0;
      while (x < size) {
        if (!rows[y][x]) { x++; continue; }
        let w = 1;
        while (x + w < size && rows[y][x + w]) w++;
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x + quiet); r.setAttribute('y', y + quiet);
        r.setAttribute('width', w); r.setAttribute('height', 1);
        mods.append(r);
        x += w;
      }
    }
    el.append(mods);
    return el;
  }

  return { encode, svg, ecc };
})();

if (typeof window !== 'undefined') window.QR = QR;
if (typeof module !== 'undefined') module.exports = QR;
