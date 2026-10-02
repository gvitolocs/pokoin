import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSellerBook } from './seller-shop-filter.js';

const rows = [
  { id: '1', cardId: 'a', cardName: 'Pikachu', setName: 'Base', collectorNumber: '58', condition: 'NM', language: 'EN', reverse: false, firstEdition: false, rarity: 'Common', foilState: 'standard', pricePkn: 10, quantityAvailable: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
  { id: '2', cardId: 'a', cardName: 'Pikachu', setName: 'Base', collectorNumber: '58', condition: 'LP', language: 'IT', reverse: true, firstEdition: false, rarity: 'Common', foilState: 'reverse', pricePkn: 4, quantityAvailable: 2, updatedAt: '2026-10-02T00:00:00.000Z' },
  { id: '3', cardId: 'b', cardName: 'Charizard', setName: 'Base', collectorNumber: '4', condition: 'NM', language: 'EN', reverse: true, firstEdition: true, rarity: 'Holo Rare', foilState: 'holo', pricePkn: 40, quantityAvailable: 1, updatedAt: '2026-09-01T00:00:00.000Z' },
];

test('reverse filter keeps only reverse rows and stays local', () => {
  const filtered = filterSellerBook(rows, { reverse: true, sort: 'price-asc' });
  assert.deepEqual(filtered.rows.map((row) => row.id), ['2', '3']);
  assert.equal(filtered.unique, 2);
});

test('condition language rarity and name search stack', () => {
  const filtered = filterSellerBook(rows, {
    q: 'pika',
    condition: 'SP',
    language: 'IT',
    reverse: true,
  });
  assert.deepEqual(filtered.rows.map((row) => row.id), ['2']);
});

test('holo matches foil state or rarity text', () => {
  const filtered = filterSellerBook(rows, { rarity: 'holo' });
  assert.deepEqual(filtered.rows.map((row) => row.id), ['3']);
});

test('price sort puts the cheapest reverse first', () => {
  const filtered = filterSellerBook(rows, { reverse: true, sort: 'price-asc' });
  assert.equal(filtered.rows[0].id, '2');
  const desc = filterSellerBook(rows, { reverse: true, sort: 'price-desc' });
  assert.equal(desc.rows[0].id, '3');
});
