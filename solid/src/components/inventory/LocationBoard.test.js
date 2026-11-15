import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Was market/src/location-board.browser.test.cjs (rendered the React board);
// the grouping itself is groupBoxStacks (market/src/inventory-listings.test.js).
const src = fs.readFileSync(new URL('./LocationBoard.jsx', import.meta.url), 'utf8');

test('a flat box is one "Cards in the box" list; divider stacks add a Stacks stat', () => {
  assert.match(src, /stacksOf\(props\.rows, box\(\)\)/);
  assert.match(src, /stack === 0 \? 'Cards in the box' : `Stack \$\{stack\}`/);
  assert.match(src, /<Show when=\{dividerCount\(\) > 0\}><div class="inv-stat"><strong>\{dividerCount\(\)\}<\/strong><span>Stacks<\/span><\/div><\/Show>/);
  assert.match(src, /` · pos \$\{row\.slotPositionText \|\| row\.slotPosition\}`/);
});

test('the grouping is walked once and its postings paint 40 at a time', () => {
  // Six readers of `stacks` on an unmemoized walk meant six passes over the box.
  assert.match(src, /const stacks = createMemo\(\(\) => stacksOf\(props\.rows, box\(\)\)\)/);
  assert.match(src, /const stacksOf = memoizePair\(groupBoxStacks\)/);
  assert.match(src, /stack\.postings\.slice\(0, limitOf\(stack\)\)/);
  assert.match(src, /setLimit\(stack, nextCollectionBatch\(limitOf\(stack\), stack\.postings\.length\)\)/);
});
