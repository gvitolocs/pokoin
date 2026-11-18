import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  chooseSortField,
  DEFAULT_SORT_FIELDS,
  DUPLICATE_SORT_MESSAGE,
  naturalCmp,
  SORT_OPTIONS,
  sortLevelEnabled,
  sortSequence,
  sortZeroLines,
  validateSortFields,
} from './zero-sort.js';

// Owned by the Rust side (zero.rs reads it with include_str!): the same cases, the same answers.
const CASES = JSON.parse(fs.readFileSync(
  new URL('../../pokoin-rust/crates/external/src/cardtrader/fixtures/zero-sort-cases.json', import.meta.url),
  'utf8',
));

for (const entry of CASES) {
  test(`fixture: ${entry.name}`, () => {
    const checked = validateSortFields(entry.fields);
    if (entry.error) {
      assert.equal(checked.ok, false);
      assert.equal(checked.code, entry.error);
      return;
    }
    assert.equal(checked.ok, true, checked.error);
    assert.deepEqual(sortZeroLines(entry.lines, entry.fields).map((line) => line.lineKey), entry.expected);
  });
}

test('the fixture covers the parity cases the spec asks for', () => {
  assert.ok(CASES.length >= 8);
  assert.ok(CASES.some((entry) => entry.error === 'duplicate_sorting_field'));
});

test('duplicate fields are refused with Power Tools message, direction ignored', () => {
  const result = chooseSortField(DEFAULT_SORT_FIELDS, 2, 'game.desc');
  assert.equal(result.error, DUPLICATE_SORT_MESSAGE);
  assert.equal(DUPLICATE_SORT_MESSAGE, 'You cannot use the same sorting field more than once');
  assert.deepEqual(chooseSortField(DEFAULT_SORT_FIELDS, 0, 'game.desc').fields, ['game.desc', 'location.asc', 'none', 'none']);
  assert.equal(validateSortFields(['cn.asc', 'cn.desc']).code, 'duplicate_sorting_field');
});

test('levels: n+1 disabled until n is set; clearing a level clears the ones after it', () => {
  assert.equal(sortLevelEnabled(['game.asc', 'none', 'none', 'none'], 1), true);
  assert.equal(sortLevelEnabled(['game.asc', 'none', 'none', 'none'], 2), false);
  assert.deepEqual(chooseSortField(['game.asc', 'location.asc', 'price.desc', 'none'], 1, 'none').fields, ['game.asc', 'none', 'none', 'none']);
});

test('options: PT labels with (asc)/(desc), rarity common to rare', () => {
  const labels = SORT_OPTIONS.map((option) => option.label);
  for (const label of ['None', 'Extras', 'CN (asc)', 'Color (alphabetical) (desc)', 'Order Bin (asc)', 'Rarity (common to rare)',
    'Rarity (rare to common)', 'Release date + Expansion code (asc)', 'Localized name (desc)', 'Game (asc)']) {
    assert.ok(labels.includes(label), label);
  }
  assert.ok(SORT_OPTIONS.some((option) => option.value === 'product.rarity.desc'));
});

test('natural compare and the PT sequence', () => {
  assert.equal(naturalCmp('box2', 'box10'), -1);
  assert.equal(naturalCmp('Box07', 'box7'), 0);
  assert.deepEqual(sortSequence([{ itemId: 7 }, { itemId: '7' }, { itemId: 8 }]), ['7', '8']);
});
