import assert from 'node:assert/strict';
import test from 'node:test';
import { prefersArtworkDelta, rarityRowTheme } from './rarity-theme.js';

test('gold, rainbow, and ghost rarities color the row; artwork and artist do not', () => {
  assert.equal(rarityRowTheme({
    number: 'Gold Secret Rare | 113/076',
    artist: 'Mitsuhiro Arita',
    artShade: '#2244aa',
  }).kind, 'gold');
  assert.equal(rarityRowTheme({ number: 'Hyper Rare | 199/165' }).kind, 'rainbow');
  assert.equal(rarityRowTheme({ number: 'Rainbow Rare | 150/145' }).kind, 'rainbow');
  assert.equal(rarityRowTheme({ rarity: 'Rainbow Secret Rare', number: '226/214' }).kind, 'rainbow');
  assert.equal(rarityRowTheme({ rarity: 'Ghost Rare' }).kind, 'ghost');
  assert.equal(rarityRowTheme({ cardType: 'Psychic', number: '069/159' }), null);
  assert.equal(rarityRowTheme({
    name: 'Mimikyu ex',
    number: '069/159',
    emoji: '👻 🌫️',
    artist: 'Mitsuhiro Arita',
    artShade: '#2244aa',
  }), null);
  assert.equal(prefersArtworkDelta({
    emoji: '👻',
    artShade: '#2244aa',
  }), true);
  assert.equal(prefersArtworkDelta({ rarity: 'Ghost Rare' }), false);
  assert.equal(rarityRowTheme({
    number: 'Ultra Rare | 069/159',
    artist: 'Yuya Oka',
    artShade: '#453d2d',
  }), null);
  const ghost = rarityRowTheme({ rarity: 'Ghost Rare' });
  assert.equal(ghost.shade, '#4c1d86');
  const gold = rarityRowTheme({ number: 'Gold | 001/001' });
  assert.notEqual(gold.shade, ghost.shade);
  assert.equal(rarityRowTheme({ cardType: 'Ghost' }), null);
});
