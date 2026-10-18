import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const mark = read('./ExpansionMark.jsx');

test('a stamped deck printing shows its stamp before the set mark, then the code', () => {
  assert.match(mark, /expansionStampSrc\(\{ slug: slug\(\), number: props\.number \}\),\s*expansionSymbolSrc\(/);
  // A missing stamp plate falls through to the set mark, not straight to letters.
  assert.match(mark, /onError=\{\(\) => setFailed\(\(n\) => n \+ 1\)\}/);
  assert.match(mark, /fallback=\{<span class="set-shortcut-code">/);
});

test('desk version row and search suggest pass the printing number', () => {
  assert.match(read('../pages/Card.jsx'), /<ExpansionMark\s+setName=\{ident\.set\}\s+number=\{row\.number \|\| row\.card_number\}/);
  assert.match(read('./SearchBox.jsx'), /<ExpansionMark\s+setName=\{identity\(\)\.set\}\s+number=\{card\(\)\.number \|\| card\(\)\.card_number\}/);
});

test('expansion page title uses the Trainer Kit mascot stamp first', () => {
  assert.match(read('../pages/Expansion.jsx'), /expansionStampSrc\(\{ slug \}\) \|\| expansionSymbolSrc\(/);
});
