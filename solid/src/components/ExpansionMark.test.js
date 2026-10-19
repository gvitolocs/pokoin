import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const mark = read('./ExpansionMark.jsx');

test('a stamped deck printing shows its stamp before the set mark, then the code', () => {
  // Stamp, then the set mark SVG and its PNG (expansionSymbolSources), then letters.
  assert.match(mark, /expansionStampSrc\(\{ slug: slug\(\), number: props\.number, id: props\.cardId \}\),\s*\.\.\.expansionSymbolSources\(/);
  // A missing stamp plate falls through to the set mark, not straight to letters.
  // The failed source is remembered (image-fallback-memo) and the next one is tried.
  assert.match(mark, /onError=\{\(\) => \{\s*rememberImageFallback\(src\(\), DEAD_IMAGE, [^)]*\);\s*setFailed\(\(n\) => n \+ 1\);/);
  assert.match(mark, /fallback=\{<span class="set-shortcut-code">/);
});

test('desk version row and search suggest pass the printing number', () => {
  // Set shortcuts are keyed by id, so the row is an accessor.
  assert.match(read('../pages/Card.jsx'), /<ExpansionMark\s+setName=\{ident\(\)\.set\}\s+number=\{row\(\)\.number \|\| row\(\)\.card_number\}\s+cardId=\{row\(\)\.id\}/);
  assert.match(read('./SearchBox.jsx'), /<ExpansionMark\s+setName=\{identity\(\)\.set\}\s+number=\{card\(\)\.number \|\| card\(\)\.card_number\}\s+cardId=\{card\(\)\.id\}/);
});

test('expansion page title uses the Trainer Kit mascot stamp first', () => {
  // ExpansionMark tries the stamp, the SVG, the PNG, then the code.
  assert.match(read('../pages/Expansion.jsx'), /<ExpansionMark\s+class="set-sym"\s+slug=\{slug\}/);
});
