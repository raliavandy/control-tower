/* Control Tower — pasted screenshots. Loaded after app-core.js. */

/* -------------------------------------------------- pasted screenshots

   Claude Code has no flag for attaching an image to a resumed prompt, so the server drops
   each one next to the prompt file and the message points at the paths. Attachments hang off
   the session id, which means the card box and the drawer box share one tray. */

const MAX_SHOTS = 6;
const MAX_SHOT_BYTES = 8 * 1024 * 1024;
const shots = new Map();                        // session id -> [{ name, type, data }]

const shotsOf = (id) => shots.get(id) || [];

async function addShot(id, file) {
  if (!file.type.startsWith('image/')) return;
  if (file.size > MAX_SHOT_BYTES) return toast('That image is too big', '8 MB is the limit', 'bad');
  const list = shotsOf(id);
  if (list.length >= MAX_SHOTS) return toast(`${MAX_SHOTS} images is the limit`, '', 'bad');
  let data;
  try {
    data = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error || new Error('could not read the image'));
      fr.readAsDataURL(file);
    });
  } catch (e) {
    return toast('Could not read that image', e.message, 'bad');
  }
  shots.set(id, [...list, { name: file.name || 'pasted image', type: file.type, data }]);
  paintShots(id);
}

function dropShot(id, index) {
  const list = shotsOf(id).slice();
  list.splice(index, 1);
  if (list.length) shots.set(id, list); else shots.delete(id);
  paintShots(id);
}

function shotTray(id, tray) {
  const list = shotsOf(id);
  tray.hidden = !list.length;
  tray.replaceChildren();
  list.forEach((shot, i) => {
    const wrap = h('span', 'shot');
    const img = document.createElement('img');
    img.src = shot.data;
    img.alt = shot.name;
    img.title = shot.name;
    const kill = h('button', 'shot-x', '×');
    kill.title = 'Remove';
    kill.addEventListener('click', () => dropShot(id, i));
    wrap.append(img, kill);
    tray.append(wrap);
  });
}

function paintShots(id) {
  const card = cards.get(id);
  if (card) shotTray(id, card.querySelector('.shots'));
  if (id === composeKey()) shotTray(id, $('#drawer-shots'));
}

// Paste and drag-drop both land here; anything that is not an image is left to the textarea.
// A provider that can't take images (today: any API-key provider) just never intercepts these -
// paste falls through to the browser's normal handling, and an un-prevented dragover shows the
// "not allowed" cursor on its own, so there's nothing extra to tell the user.
function wireShots(id, ta) {
  ta.addEventListener('paste', (e) => {
    if (!providerOf(cur(id)).hasImages) return;
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => addShot(id, f));
  });
  ta.addEventListener('dragover', (e) => {
    if (!providerOf(cur(id)).hasImages) return;
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    ta.classList.add('dropping');
  });
  ta.addEventListener('dragleave', () => ta.classList.remove('dropping'));
  ta.addEventListener('drop', (e) => {
    if (!providerOf(cur(id)).hasImages) return;
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    ta.classList.remove('dropping');
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => addShot(id, f));
  });
}
