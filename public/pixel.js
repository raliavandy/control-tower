/* Control Tower - pixel mascots.
   Each sprite is 12x12 string art turned into <rect>s, so it recolours itself from whatever
   `color` the card sets, and animates as a two-frame flipbook driven by one CSS keyframe pair.
   '#' = body · 'o' = cut-out (eyes) · '-' = thin cut-out (lids / mouth) · '.' = nothing. */

const PX = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  const ART = {
    neutral: [
      '.....##.....',
      '....####....',
      '..########..',
      '.##########.',
      '.##oo##oo##.',
      '.##oo##oo##.',
      '.##########.',
      '.###----###.',
      '.##########.',
      '..########..',
      '..##....##..',
      '..##....##..',
    ],
    talking: [
      '.....##.....',
      '....####....',
      '..########..',
      '.##########.',
      '.##oo##oo##.',
      '.##oo##oo##.',
      '.##########.',
      '.##oooooo##.',
      '.##oooooo##.',
      '..########..',
      '..##....##..',
      '.##......##.',
    ],
    blink: [
      '.....##.....',
      '....####....',
      '..########..',
      '.##########.',
      '.##########.',
      '.##--##--##.',
      '.##########.',
      '.###----###.',
      '.##########.',
      '..########..',
      '..##....##..',
      '..##....##..',
    ],
    lookdown: [
      '.....##.....',
      '....####....',
      '..########..',
      '.##########.',
      '.##########.',
      '.##oo##oo##.',
      '.##oo##oo##.',
      '.###----###.',
      '.##########.',
      '..########..',
      '..##....##..',
      '..##....##..',
    ],
    sleep: [
      '.....##.....',
      '....####....',
      '..########..',
      '.##########.',
      '.##########.',
      '.##--##--##.',
      '.##########.',
      '.####--####.',
      '.##########.',
      '..########..',
      '..##....##..',
      '..##....##..',
    ],
  };

  const DECO = {
    bang: ['.##..', '.##..', '.##..', '.....', '.##..'],
    zed: ['####.', '...#.', '..#..', '.#...', '####.'],
  };

  // Personality per status. `ms` is the flipbook period; 0 means hold a single frame.
  const MOOD = {
    blocked: { frames: ['talking', 'neutral'], ms: 260, deco: 'bang' },
    'waiting-for-you': { frames: ['neutral', 'talking'], ms: 620, deco: 'bang' },
    working: { frames: ['neutral', 'lookdown'], ms: 1100, deco: 'dots' },
    // Same job, taking its time: the dots keep going but nothing about it is urgent.
    long: { frames: ['neutral', 'lookdown'], ms: 2000, deco: 'dots' },
    // Turn finished a while back and nobody is waiting on anybody: resting, not nagging.
    done: { frames: ['neutral'], ms: 0, deco: null },
    idle: { frames: ['sleep'], ms: 0, deco: 'zed' },
    // A chat that lives in the page: awake, unhurried, waiting for your next message.
    here: { frames: ['neutral', 'blink'], ms: 2400, deco: null },
    ended: { frames: ['blink'], ms: 0, deco: null },
  };

  // Runs of the same character collapse into one rect - a sprite costs ~30 nodes, not 144.
  function pixels(art, ox, oy, cls) {
    const g = document.createElementNS(NS, 'g');
    if (cls) g.setAttribute('class', cls);
    art.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        if (ch === '.') { x++; continue; }
        let w = 1;
        while (row[x + w] === ch) w++;
        // The fill lives in CSS (.px-body / .px-ink): the sheet's global `svg { fill: none }`
        // is inherited, and inherited CSS beats a fill="" presentation attribute.
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('class', ch === '#' ? 'px-body' : 'px-ink');
        r.setAttribute('x', ox + x);
        r.setAttribute('y', oy + y);
        r.setAttribute('width', w);
        r.setAttribute('height', 1);
        g.append(r);
        x += w;
      }
    });
    return g;
  }

  function dots() {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'deco dots');
    [13, 15, 17].forEach((x, i) => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', 'px-body');
      r.setAttribute('x', x); r.setAttribute('y', 4);
      r.setAttribute('width', 1); r.setAttribute('height', 1);
      r.style.animationDelay = i * 180 + 'ms';
      g.append(r);
    });
    return g;
  }

  // 18x14 viewBox: the mascot sits at (0,2), decorations get the strip to its right.
  // Every sprite gets a different negative animation-delay, or a boardful of them would
  // blink in perfect lockstep - they are all created in the same frame.
  let born = 0;
  function sprite(status, extra) {
    const mood = MOOD[status] || MOOD.ended;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 18 14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', ['sprite', 'm-' + status, mood.frames.length < 2 ? 'still' : '', extra].filter(Boolean).join(' '));
    svg.style.setProperty('--phase', -((born++ * 137) % 1000) + 'ms');
    if (mood.ms) svg.style.setProperty('--flip', mood.ms + 'ms');
    svg.append(pixels(ART[mood.frames[0]], 0, 2, 'fr a'));
    if (mood.frames[1]) svg.append(pixels(ART[mood.frames[1]], 0, 2, 'fr b'));
    if (mood.deco === 'dots') svg.append(dots());
    else if (mood.deco) svg.append(pixels(DECO[mood.deco], 13, 1, 'deco ' + mood.deco));
    return svg;
  }

  // A caret that bounces at whatever needs you first.
  const CARET = ['#....', '##...', '###..', '####.', '###..', '##...', '#....'];
  function caret() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 5 7');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'caret');
    svg.append(pixels(CARET, 0, 0, ''));
    return svg;
  }

  /* The tab icon doubles as the alarm: it turns red the moment something needs you. */
  const FAV = { blocked: '#f87171', 'waiting-for-you': '#fbbf24', working: '#34d399', long: '#3fa9a0', done: '#5f9e86', here: '#7aa2f7', idle: '#8296ad', ended: '#4a5a6e' };
  let favKey = '';
  function favicon(status) {
    if (status === favKey) return;
    favKey = status;
    const art = ART[status === 'idle' ? 'sleep' : status === 'ended' ? 'blink' : 'neutral'];
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const s = 2, off = (32 - 12 * s) / 2;
    art.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = ch === '#' ? (FAV[status] || FAV.ended) : '#0b0f14';
      g.fillRect(off + x * s, off + y * s, s, s);
    }));
    const link = document.getElementById('favicon');
    if (link) link.href = c.toDataURL('image/png');
  }

  return { sprite, caret, favicon };
})();

window.PX = PX;
