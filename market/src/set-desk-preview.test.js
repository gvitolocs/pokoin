import assert from 'node:assert/strict';
import test from 'node:test';
import { filterExpansionCards } from './search-filters.js';
import {
  SET_PREVIEW_BATCH,
  firstSetPreviewCount,
  nextSetPreviewCount,
  setDeskSkeletonCount,
} from './set-desk-preview.js';

test('set desk homepage previews load twelve cards at a time', () => {
  assert.equal(SET_PREVIEW_BATCH, 12);
  assert.equal(firstSetPreviewCount(167), 12);
  assert.equal(firstSetPreviewCount(8), 8);
  assert.equal(firstSetPreviewCount(0), 0);
  assert.equal(nextSetPreviewCount(12, 167), 24);
  assert.equal(nextSetPreviewCount(160, 167), 167);
  assert.equal(nextSetPreviewCount(167, 167), 167);
  assert.equal(nextSetPreviewCount(0, 167), 12);
});

test('walk skeletons follow expansion cardCount, not a fixed 24', () => {
  assert.equal(setDeskSkeletonCount({ cardCount: 217 }), 217);
  assert.equal(setDeskSkeletonCount({ total: 96 }), 96);
  assert.equal(setDeskSkeletonCount(null), 24);
  assert.equal(setDeskSkeletonCount({}), 24);
});

test('preview batches follow Number order, Official when a checklist exists', () => {
  const rows = [
    { id: 'c', name: 'Clefable', number: '003/217' },
    { id: 'a', name: 'Bulbasaur', number: '001/217' },
    { id: 'b', name: 'Ivysaur', number: '002/217' },
  ];
  const numbered = filterExpansionCards(rows, { sort: 'number' });
  assert.deepEqual(numbered.slice(0, firstSetPreviewCount(numbered.length)).map((row) => row.id), [
    'a',
    'b',
    'c',
  ]);
  const long = Array.from({ length: 30 }, (_, index) => ({
    id: String(index + 1),
    name: `Card ${index + 1}`,
    number: `${String(30 - index).padStart(3, '0')}/217`,
  }));
  const ordered = filterExpansionCards(long, { sort: 'number' });
  assert.deepEqual(
    ordered.slice(0, firstSetPreviewCount(ordered.length)).map((row) => row.number),
    Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(3, '0')}/217`),
  );
  const official = filterExpansionCards([
    { id: '2', name: 'Reshiram', number: 'Holo Rare | 002/025' },
    { id: '1', name: 'Ho-Oh', number: 'Holo Rare | 001/025' },
  ], { sort: 'official', expansionSlug: 'celebrations' });
  assert.deepEqual(official.map((row) => row.id), ['1', '2']);
});
