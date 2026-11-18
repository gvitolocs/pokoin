import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./Versions.jsx', import.meta.url), 'utf8');

test('Versions soft-fails CLIP version-set so satellite rarities still paint', () => {
  assert.match(src, /fetchVersionSet\(cardId, \{ onUpdate: revise\('set'\) \}\)\.catch\(\(\) => \(\{ printings: \[\] \}\)\)/);
  assert.match(src, /isNameReprintCard\(\{ name \}\)/);
  assert.match(src, /fetchNamePrintings\(name/);
  assert.match(src, /page\?\.rarities/);
  assert.match(src, /page\?\.versions/);
});

test('stored copies paint at once and revalidated ones recompute the lineup in place', () => {
  assert.match(src, /fetchCard\(cardId, \{ lang, slug, onUpdate: revise\('page'\) \}\)/);
  assert.match(src, /const \{ set: newSet, page: newPage \} = revised\(\);/);
  assert.match(src, /load\(newSet \|\| set, newPage \|\| page\)/);
  // The exact-name batches are not asked again on every revalidation.
  assert.match(src, /!batched\) \{\n\s+batched = true;/);
});

test('era names are gold links to the era setlist', () => {
  assert.match(src, /class="era-link"/);
  assert.match(src, /eraHref\(group\.label\)/);
  assert.match(src, /setName\(\) \? `From \$\{setName\(\)\}` : 'Same expansion'/);
});
