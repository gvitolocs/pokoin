import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const lib = fs.readFileSync(new URL('./buy-book.js', import.meta.url), 'utf8');
const bar = fs.readFileSync(new URL('../components/desk/OfferBar.jsx', import.meta.url), 'utf8');

/**
 * CARD-01 P4. The line the visitor waits for on the sell side is computed from
 * `HOUSE_OFFER_PKN`, a client constant, so nothing about it needs an answer: the
 * measured desk left the offer bar and the Buy offers cell silent for 1.26 s
 * because the book was `null` until its request landed.
 */
test('an unseen book is an empty one, and an empty one has something to say', () => {
  assert.match(lib, /const first = storedBook\(cardId, preview\);/);
  // `book` is what to draw and never null; `known` is the only thing a skeleton may wait for.
  assert.match(lib, /const \[book, setBook\] = createSignal\(first \|\| \[\]\);/);
  assert.match(lib, /const \[known, setKnown\] = createSignal\(first !== null\);/);
  assert.match(lib, /return \{\n\s*preview,\n\s*book,\n\s*\/\*\*[^*]*\*\/\n\s*known,/);
});

test('the book read waits for idle, not for the listings', () => {
  assert.doesNotMatch(lib, /\bready\b/);
  assert.match(lib, /createEffect\(\n\s*\(\) => \(cardId \? String\(cardId\) : ''\),/);
  assert.match(lib, /whenIdle\(\(\) => \{ load\(id\); \}, 300\)/);
  // The re-seed the desk reload depends on stays: a card change repaints from
  // this device's copy before the new answer lands.
  assert.match(lib, /const seed = storedBook\(id, preview\);\n\s*setBook\(seed \|\| \[\]\);\n\s*setKnown\(seed !== null\);/);
});

test('known flips with the answer, with the fixture book and with a failure', () => {
  // Three and not two: a request that never answers leaves an empty book rather
  // than an offer bar stuck in its skeleton.
  assert.equal((lib.match(/setKnown\(true\);/g) || []).length, 3);
  assert.match(lib, /setBook\(\(\) => previewBook\(untrack\(language\), scale\)\.book\);\n\s*setKnown\(true\);/);
  // A revalidation that changed nothing keeps the rows on screen (rule 3).
  assert.match(lib, /setBook\(\(current\) => \(JSON\.stringify\(current\) === JSON\.stringify\(rows\) \? current : rows\)\);/);
});

test('the offer bar holds its skeleton for the flag and not for the rows', () => {
  assert.match(bar, /const loading = \(\) => !buy\.known\(\);/);
  assert.doesNotMatch(bar, /const loading = \(\) => book\(\) == null;/);
});
