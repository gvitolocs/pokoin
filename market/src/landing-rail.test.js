import assert from 'node:assert/strict';
import test from 'node:test';
import { railTiles } from './landing-rail.js';

const card = (id, name, extra = {}) => ({
  id: String(id),
  card_id: String(id),
  name,
  set: 'Evolutions',
  number: '35/108',
  productType: 'card',
  itemKind: 'single',
  price: 40,
  ...extra,
});

test('railTiles keeps the rail order and drops nameless tiles', () => {
  const rail = {
    kind: 'bestSellers',
    sectionKey: 'bestSellerIds',
    limit: 12,
    cards: [card(2, 'Tornadus'), card(1, 'Pikachu'), card(3, '')],
    sections: { bestSellerIds: ['2', '1', '3'] },
  };
  assert.deepEqual(railTiles(rail).map((tile) => tile.name), ['Tornadus', 'Pikachu']);
});

test('railTiles is empty without a rail', () => {
  assert.deepEqual(railTiles(null), []);
  assert.deepEqual(railTiles({ cards: [], sectionKey: 'bestSellerIds' }), []);
});

test('railTiles caps the rail', () => {
  const cards = Array.from({ length: 20 }, (_, i) => card(i + 1, `Card ${i + 1}`));
  const rail = { sectionKey: 'bestSellerIds', limit: 20, cards };
  assert.equal(railTiles(rail, 5).length, 5);
});
