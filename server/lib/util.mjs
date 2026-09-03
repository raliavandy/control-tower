// Small, dependency-free helpers shared between server.mjs and the provider modules under
// server/providers/ - kept here rather than duplicated so a fix only has to happen once.

import fs from 'node:fs';

export const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s || '');

export function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Write, then read the temp file back and verify it parses, before it becomes the real file -
// so a truncated or corrupt write (disk full, process killed mid-write) never lands in place.
export function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { JSON.parse(fs.readFileSync(tmp, 'utf8')); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw new Error('the written file did not parse: ' + e.message); }
  fs.renameSync(tmp, file);
}
