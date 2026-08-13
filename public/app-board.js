/* Rals Cockpit — the board, and your own sections. Loaded after app-cards.js. */

/* ------------------------------------------------------------------ board render */

const cur = (id) => sessions.find((s) => s.id === id) || {};

/* -------------------------------------------------- sections (your own tab groups)

   A section holds exactly the chats you put in it - nothing else, ever. It starts empty and
   membership is only ever changed by you, from the "sections" menu on a card. (An earlier
   version also auto-matched on the search text you had typed, which made a brand new section
   arrive already full of chats nobody had added.) */

const activeSection = () => sectionList.find((x) => x.id === sectionId) || null;
const saveSections = () => { store.set('sections', sectionList); store.set('section', sectionId); };

const haystack = (s) => [s.title, s.project, s.gitBranch, s.lastPrompt, s.cwd, s.id, s.procName, s.origin?.label,
  ...Object.keys(s.mcpUsed || {}), ...Object.keys(s.skillsUsed || {})].join(' ').toLowerCase();

const inSection = (s, section) => !section || section.members.includes(s.id);

function visible() {
  const q = query.trim().toLowerCase();
  const section = activeSection();
  return sessions.filter((s) => {
    if (!inSection(s, section)) return false;
    if (filter === 'needs' && !s.needsYou) return false;
    if (filter === 'live' && !onDeck(s)) return false;
    if (isDismissed(s)) return false;
    if (!q) return true;
    return haystack(s).includes(q);
  });
}

// Sections created by the older build carried a query and a `pins` list; fold them into the
// membership model rather than silently keeping the auto-matching behaviour.
function migrateSections() {
  let touched = false;
  for (const section of sectionList) {
    if (!Array.isArray(section.members)) {
      section.members = Array.isArray(section.pins) ? section.pins : [];
      touched = true;
    }
    if ('pins' in section || 'query' in section || 'filter' in section || 'groupBy' in section) {
      delete section.pins; delete section.query; delete section.filter; delete section.groupBy;
      touched = true;
    }
  }
  if (touched) saveSections();
}

function paintSections() {
  const nav = $('#sections');
  const add = $('#section-add');
  nav.replaceChildren();

  const all = h('button', 'tabgroup' + (sectionId ? '' : ' on'), 'everything');
  all.title = 'Every session — no section filter';
  all.addEventListener('click', () => applySection(''));
  nav.append(all);

  for (const section of sectionList) {
    const b = h('button', 'tabgroup' + (section.id === sectionId ? ' on' : ''));
    b.append(h('span', 'tabgroup-name', section.name));
    b.append(h('span', 'count', String(section.members.length)));
    b.title = `${section.members.length} chat${section.members.length === 1 ? '' : 's'} in this section` +
      '\nAdd or remove them from the "sections" link on a card.' +
      '\nDouble-click to rename · right-click to delete';
    b.addEventListener('click', () => applySection(section.id));
    b.addEventListener('dblclick', (e) => { e.preventDefault(); renameSection(section); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); deleteSection(section); });
    nav.append(b);
  }
  nav.append(add);
}

// Selecting a section narrows the board to its members and touches nothing else - your search
// text, filter and grouping stay exactly as you left them.
function applySection(id) {
  sectionId = id;
  saveSections();
  resetGroups();
  paintSections();
  render();
}

function newSection(seedId) {
  const name = (prompt('Name this section') || '').trim();
  if (!name) return null;
  const section = { id: 's' + Date.now().toString(36), name: name.slice(0, 28), members: seedId ? [seedId] : [] };
  sectionList.push(section);
  saveSections();
  paintSections();
  render();
  toast(`“${section.name}” created`, seedId ? 'this chat is in it' : 'add chats from the sections link on a card', 'good');
  return section;
}

function renameSection(section) {
  const name = (prompt('Rename section', section.name) || '').trim();
  if (!name) return;
  section.name = name.slice(0, 28);
  saveSections();
  paintSections();
  render();
}

function deleteSection(section) {
  if (!confirm(`Delete the “${section.name}” section? The chats themselves are untouched.`)) return;
  sectionList = sectionList.filter((x) => x.id !== section.id);
  if (sectionId === section.id) sectionId = '';
  saveSections();
  paintSections();
  render();
}

function toggleMember(section, id) {
  section.members = section.members.includes(id)
    ? section.members.filter((x) => x !== id)
    : [...section.members, id];
  saveSections();
  paintSections();
  render();
}
