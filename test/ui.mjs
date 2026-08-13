/* Browser suite. Skipped with a note if Playwright is not resolvable, since the API suites
   already cover the dangerous paths. */

import { pathToFileURL } from 'node:url';
import { describe, ok, eq, base, haveBrowser, post } from './harness.mjs';
import { decode } from './qr-decode.mjs';

const entry = haveBrowser();
if (!entry) {
  await describe('ui (skipped)', async () => {
    ok(true, 'Playwright not found — install it, or run the API suites alone');
  });
} else {
  // pathToFileURL: "file://" + "C:\..." parses C: as a hostname and the import never settles.
  const { chromium } = await import(pathToFileURL(entry).href);
  const browser = await chromium.launch();

  /* Settings come from the server now and deliberately beat localStorage, so a page is set up by
     POSTing prefs rather than seeding browser storage. */
  const page = async (prefs = {}) => {
    await post('/api/prefs', {
      patch: { theme: 'dark', view: 'sessions', filter: 'all', groupby: 'none', ...prefs },
    });
    const p = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    p.setDefaultTimeout(15000);
    const errors = [];
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(base() + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.card', { timeout: 20000 });
    await p.waitForTimeout(900);
    return { p, errors };
  };

  await describe('ui — the page loads clean', async () => {
    const { p, errors } = await page();
    eq(errors, [], 'no console or page errors on load');
    ok(await p.locator('.card').count() > 0, 'the board rendered cards');
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no sideways scroll');
    await p.close();
  });

  await describe('ui — Enter is a newline, Ctrl+Enter sends', async () => {
    const { p, errors } = await page();
    const sends = [];
    await p.route('**/api/reply', (r) => { sends.push('reply'); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"terminal":"test"}' }); });
    await p.route('**/api/chat', (r) => { sends.push('chat'); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"run_test","sessionId":"11111111-2222-3333-4444-555555555555","stance":"read only"}' }); });

    const ta = p.locator('.card textarea').first();
    await ta.click();
    await ta.type('line one');
    await p.keyboard.press('Enter');
    await ta.type('line two');
    await p.keyboard.press('Shift+Enter');
    await ta.type('line three');
    await p.waitForTimeout(400);
    eq(sends, [], 'typing with Enter and Shift+Enter sent nothing');
    eq((await ta.inputValue()).split('\n').length, 3, 'and kept all three lines');

    await p.keyboard.press('Control+Enter');
    await p.waitForTimeout(700);
    ok(sends.length === 1, `Ctrl+Enter sent exactly once (got ${sends.length})`);
    // The mocked reply invents a runId the server has never heard of, so its event stream 404s.
    // That is the mock's doing, not the app's; anything else is a real error.
    eq(errors.filter((e) => !/404/.test(e)), [], 'no errors beyond the mocked run stream');
    await p.close();
  });

  await describe('ui — counts match what is on the board', async () => {
    const { p, errors } = await page({ dismissed: {} });
    const read = () => p.evaluate(() => ({
      badge: Number(document.querySelector('#c-all').textContent),
      cards: document.querySelectorAll('.card').length,
    }));
    const before = await read();
    eq(before.badge, before.cards, 'the All count equals the cards shown');
    await p.click('.card .card-x');
    await p.waitForTimeout(400);
    const after = await read();
    eq(after.badge, after.cards, 'still equal after dismissing one');
    ok(after.cards === before.cards - 1, 'and one fewer card is shown');
    ok(!(await p.locator('#undismiss').isHidden()), 'a way back is offered');
    eq(errors, [], 'no errors');
    await p.close();
  });

  await describe('ui — a card expands in place', async () => {
    const { p, errors } = await page({ expanded: {} });
    const id = await p.evaluate(() => document.querySelector('.card').dataset.id);
    await p.click(`.card[data-id="${id}"] .card-expand`);
    await p.waitForSelector(`.card[data-id="${id}"] .cmsg`, { timeout: 20000 });
    const msgs = await p.locator(`.card[data-id="${id}"] .cmsg`).count();
    ok(msgs > 0, `it showed ${msgs} messages inline`);
    await p.close();
    ok(errors.length === 0, 'no errors');
  });

  await describe('ui — every button has an accessible name', async () => {
    const { p } = await page();
    const nameless = await p.evaluate(() => [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => !(b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent.trim()))
      .map((b) => b.className || b.id));
    eq(nameless, [], 'no visible button is unnamed');
    ok(await p.locator('.skiplink').count() === 1, 'there is a skip link');
    await p.close();
  });

  await describe('ui — dialogs keep focus and give it back', async () => {
    const { p, errors } = await page();
    await p.click('.card .act-transcript');
    await p.waitForSelector('#drawer-body .msg', { timeout: 20000 });
    const escaped = await p.evaluate(async () => {
      const drawer = document.querySelector('#drawer');
      const stops = [...drawer.querySelectorAll('a[href], button:not([disabled]), input, select, textarea')]
        .filter((el) => el.offsetParent !== null);
      stops[stops.length - 1].focus();
      return { last: document.activeElement === stops[stops.length - 1], count: stops.length };
    });
    ok(escaped.last, 'focus can reach the last control in the panel');
    await p.keyboard.press('Tab');
    const stillInside = await p.evaluate(() => document.querySelector('#drawer').contains(document.activeElement));
    ok(stillInside, 'Tab from the last control wraps rather than leaving the panel');
    eq(errors, [], 'no errors');
    await p.close();
  });

  await describe('ui — deep search finds a phrase and offers the chat', async () => {
    // Start on the board and click through, the way you would: the helper waits for a visible
    // card, which never appears if the page opens straight into another view.
    const { p, errors } = await page();
    await p.click('#views button[data-view="search"]');
    await p.waitForSelector('#deep-q', { state: 'visible' });
    await p.fill('#deep-q', 'the');
    await p.click('#search-form button[type="submit"]');
    await p.waitForSelector('.hit', { timeout: 30000 });
    const hits = await p.locator('.hit').count();
    ok(hits > 0, `found ${hits} matches`);
    ok(await p.locator('.hit mark').count() > 0, 'the match is highlighted');
    eq(errors, [], 'no errors');
    await p.close();
  });

  await describe('ui — the settings menu, with phone access always listed', async () => {
    const { p, errors } = await page();
    await p.click('#btn-more');
    await p.waitForSelector('.popover-row');
    const menu = await p.evaluate(() => ({
      rows: [...document.querySelectorAll('.popover-row')].map((r) => r.textContent.trim()),
      note: document.querySelector('.popover-note')?.textContent || '',
    }));
    ok(menu.rows.some((r) => /Phone access/i.test(r)), `phone access is listed (${menu.rows.join(' | ')})`);
    ok(menu.rows.some((r) => /alerts/i.test(r)), 'desktop alerts is listed');
    ok(menu.rows.some((r) => /Switch to/i.test(r)), 'the theme toggle is listed');
    ok(/phone access is (on|off)/i.test(menu.note) || /reach this at/.test(menu.note), 'the note says which it is');
    // One way in to the how-to, not two.
    const howTo = menu.rows.filter((r) => /how to/i.test(r)).length;
    eq(howTo, 0, 'the how-to is not duplicated inside the menu — it has its own button');
    eq(errors, [], 'no errors');
    await p.close();
  });

  await describe('ui — the how-to page is reachable and complete', async () => {
    const { p, errors } = await page();
    ok(await p.locator('#btn-help').count() === 1, 'a help button is in the top bar');
    const href = await p.locator('#btn-help').getAttribute('href');
    eq(href, '/help.html', 'pointing at the served page');

    const help = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const helpErrors = [];
    help.on('pageerror', (e) => helpErrors.push(e.message));
    await help.goto(base() + '/help.html', { waitUntil: 'domcontentloaded' });
    await help.waitForTimeout(400);
    const shape = await help.evaluate(() => ({
      sections: [...document.querySelectorAll('main section[id]')].map((s) => s.id),
      tocLinks: [...document.querySelectorAll('.toc a')].map((a) => a.getAttribute('href').slice(1)),
      keys: document.querySelectorAll('.keys > div').length,
      overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
      styled: getComputedStyle(document.querySelector('.hh h1')).fontSize,
    }));
    ok(shape.sections.length >= 13, `it documents ${shape.sections.length} areas`);
    eq(shape.tocLinks.filter((id) => !shape.sections.includes(id)), [], 'every contents link points at a real section');
    ok(shape.keys >= 12, `it lists ${shape.keys} shortcuts`);
    ok(!shape.overflows, 'no sideways scroll');
    ok(parseFloat(shape.styled) > 20, 'the stylesheet loaded');
    eq(helpErrors, [], 'no errors on the how-to page');
    await help.close();
    eq(errors, [], 'no errors on the board');
    await p.close();
  });

  /* The pairing page, both ways round. The interesting one is a code actually drawn in a browser:
     the grid is lifted back out of the rendered rectangles and decoded, so what is asserted is the
     thing a phone camera would be pointed at, not the array that went in. */
  await describe('ui — the pairing page', async () => {
    const off = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const offErrors = [];
    off.on('pageerror', (e) => offErrors.push(e.message));
    await off.goto(base() + '/pair', { waitUntil: 'domcontentloaded' });
    await off.waitForTimeout(300);
    const offText = await off.evaluate(() => document.body.innerText);
    eq(await off.locator('.qcard').count(), 0, 'no codes drawn when the port is shut');
    ok(/off for this run/i.test(offText), 'it says phone access is off');
    ok(/start-phone\.cmd/.test(offText), 'and names what to run instead');
    eq(offErrors, [], 'no errors with nothing to draw');
    await off.close();

    // The on-state without opening a LAN port for the duration of a test run: the same served page,
    // with the pairing details the server would have injected.
    const on = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const onErrors = [];
    on.on('pageerror', (e) => onErrors.push(e.message));
    const URLS = ['http://192.168.0.96:7457/?k=A1B2C3D4', 'http://10.150.52.24:7457/?k=A1B2C3D4'];
    await on.route('**/pair', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('const PHONE = null;',
        `const PHONE = ${JSON.stringify({ code: 'A1B2C3D4', urls: URLS })};`);
      await route.fulfill({ body, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    await on.goto(base() + '/pair', { waitUntil: 'domcontentloaded' });
    await on.waitForSelector('.qcard svg');
    eq(await on.locator('.qcard').count(), 2, 'one card per network address');
    const text = await on.evaluate(() => document.body.innerText);
    ok(text.includes('A1B2C3D4'), 'the access code is shown for anyone typing it by hand');
    ok(text.includes('192.168.0.96') && text.includes('10.150.52.24'), 'both addresses are named');
    ok(/same network/i.test(text), 'it warns that mobile data will not do');
    ok(!(await on.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no sideways scroll');

    const grids = await on.evaluate(() => [...document.querySelectorAll('.qcard svg')].map((svg) => {
      const [, , w] = svg.getAttribute('viewBox').split(' ').map(Number);
      const rects = [...svg.querySelectorAll('rect')].slice(1);   // the first is the white ground
      const xs = rects.map((r) => +r.getAttribute('x'));
      const ys = rects.map((r) => +r.getAttribute('y'));
      const quiet = Math.min(...xs, ...ys);
      const size = w - quiet * 2;
      const rows = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const r of rects) {
        const x = +r.getAttribute('x') - quiet, y = +r.getAttribute('y') - quiet;
        for (let i = 0; i < +r.getAttribute('width'); i++) rows[y][x + i] = 1;
      }
      return { size, rows: rows.map((r) => r.join('')), quiet, boxWidth: w };
    }));
    /* The app's stylesheet paints svgs as stroked outlines with no fill, for its icons. A code that
       inherits that renders as pale outlines: geometrically perfect, unreadable by a camera. So the
       computed colours get checked, not just the shapes. */
    const paint = await on.evaluate(() => {
      const svg = document.querySelector('.qcard svg');
      const lum = (el) => {
        const [r, g, b] = getComputedStyle(el).fill.match(/[\d.]+/g).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      };
      return {
        module: lum(svg.querySelector('.qr-mods rect')),
        ground: lum(svg.querySelector('.qr-bg')),
        stroke: getComputedStyle(svg.querySelector('.qr-mods rect')).stroke,
      };
    });
    ok(paint.module < 0.2, `the modules are actually dark (luminance ${paint.module.toFixed(2)})`);
    ok(paint.ground > 0.8, `on an actually light ground (luminance ${paint.ground.toFixed(2)})`);
    ok(paint.ground - paint.module > 0.6, 'with the contrast a camera needs');
    ok(/none/.test(paint.stroke), 'and no icon stroke bleeding into the modules');

    eq(grids.length, 2, 'both codes rendered as svg');
    for (const [i, g] of grids.entries()) {
      eq(g.quiet, 4, 'it keeps the four-module quiet border a scanner needs');
      eq(g.boxWidth, g.size + 8, 'the viewBox allows for that border');
      const read = decode({ size: g.size, rows: g.rows });
      eq(read.text, URLS[i], `the drawn code reads back as ${URLS[i]}`);
      eq(read.level, 'Q', 'at the sturdier correction level, for a phone held at an angle');
    }
    eq(onErrors, [], 'no errors drawing the codes');
    await on.close();
  });

  await browser.close();
}
