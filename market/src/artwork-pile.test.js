import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupArtworkRows, pileCardTier } from './search-filters.js';

test('pile popup tiers: normal, Poké Ball, Master Ball', () => {
  const cards = [
    { id: 'master', name: 'Ducklett', rarity: 'Master Ball Reverse Holo', expansion_name: 'White Flare - Master Ball Reverse Holo' },
    { id: 'poke', name: 'Ducklett', rarity: 'Poké Ball Reverse Holo', expansion_name: 'White Flare - Poké Ball Reverse Holo' },
    { id: 'normal', name: 'Ducklett', rarity: 'Common', expansion_name: 'White Flare' },
  ];
  const sorted = [...cards].sort((a, b) => pileCardTier(a) - pileCardTier(b));
  assert.deepEqual(sorted.map((card) => card.id), ['normal', 'poke', 'master']);
  assert.equal(pileCardTier({ id: 'x', name: 'Ducklett', rarity: 'Rare', expansion_name: 'Paldea Evolved' }), 0);
});

test('same-artwork printings pile by CLIP version key in sort order', () => {
  const groups = groupArtworkRows([
    { id: 'c1', name: 'Bulbasaur', version: 'v100' },
    { id: 'c2', name: 'Bulbasaur', version: 'v100' },
    { id: 'c3', name: 'Bulbasaur', version: 'v200' },
    { id: 'c4', name: 'Bulbasaur', version: '' },
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].cards.map((card) => card.id), ['c1', 'c2']);
  assert.deepEqual(groups[1].cards.map((card) => card.id), ['c3']);
  assert.deepEqual(groups[2].cards.map((card) => card.id), ['c4']);
});

test('cards without a version key stay singletons, never merge', () => {
  const groups = groupArtworkRows([
    { id: 'a', name: 'Pikachu' },
    { id: 'b', name: 'Pikachu' },
  ]);
  assert.equal(groups.length, 2);
});

test('LEGEND halves never pile — the landscape pair forms the full art', () => {
  const groups = groupArtworkRows([
    { id: 'top', name: 'Ho-Oh LEGEND', version: 'v10' },
    { id: 'bottom', name: 'Ho-Oh LEGEND', version: 'v12' },
  ]);
  assert.equal(groups.length, 2);
});

test('Tag Team Pokédex clones dedupe into one pile row', () => {
  const groups = groupArtworkRows([
    { id: 'c1', name: 'Pikachu & Zekrom TAG TEAM GX', version: 'v7', albumDupKey: 'c1:1' },
    { id: 'c1', name: 'Pikachu & Zekrom TAG TEAM GX', version: 'v7', albumDupKey: 'c1:2' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cards.length, 1);
});
