import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./Versions.jsx', import.meta.url), 'utf8');

test('Versions soft-fails CLIP version-set so satellite rarities still paint', () => {
  assert.match(src, /fetchVersionSet\(cardId\)\.catch\(\(\) => \(\{ printings: \[\] \}\)\)/);
  assert.match(src, /isNameReprintCard\(\{ name \}\)/);
  assert.match(src, /fetchNamePrintings\(name/);
  assert.match(src, /page\?\.rarities/);
  assert.match(src, /page\?\.versions/);
});

test('era names are gold links to the era setlist', () => {
  assert.match(src, /class="era-link"/);
  assert.match(src, /eraHref\(group\.label\)/);
  assert.match(src, /<h2>Others from the expansion<\/h2>/);
});
