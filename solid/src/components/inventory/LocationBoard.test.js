import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Was market/src/location-board.browser.test.cjs (rendered the React board);
// the grouping itself is groupBoxStacks (market/src/inventory-listings.test.js).
const src = fs.readFileSync(new URL('./LocationBoard.jsx', import.meta.url), 'utf8');

test('a flat box is one "Cards in the box" list; divider stacks add a Stacks stat', () => {
  assert.match(src, /groupBoxStacks\(props\.rows, box\(\)\)/);
  assert.match(src, /stack === 0 \? 'Cards in the box' : `Stack \$\{stack\}`/);
  assert.match(src, /<Show when=\{dividerCount\(\) > 0\}><div class="inv-stat"><strong>\{dividerCount\(\)\}<\/strong><span>Stacks<\/span><\/div><\/Show>/);
  assert.match(src, /` · pos \$\{row\.slotPositionText \|\| row\.slotPosition\}`/);
});
