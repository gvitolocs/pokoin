'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stockMatchKey,
  compactCollector,
  reconcilePowerToolsWithCardTrader,
  gamesFromCardTraderProducts,
} = require('./_powertools_ct_match');

test('collector numbers normalize leading zeros', () => {
  assert.equal(compactCollector('069/101'), '69/101');
  assert.equal(compactCollector('69/101'), '69/101');
});

test('stock match key ignores set title noise', () => {
  const a = stockMatchKey({
    name: 'Plusle',
    collectorNumber: '069/101',
    condition: 'NM',
    language: 'EN',
    reverse: true,
  });
  const b = stockMatchKey({
    name: 'Plusle',
    collectorNumber: '69/101',
    condition: 'NM',
    language: 'EN',
    reverse: true,
  });
  assert.equal(a, b);
});

test('Power Tools locations attach to matching CardTrader products', () => {
  const products = [
    {
      id: '100',
      name: 'Plusle',
      condition: 'NM',
      language: 'EN',
      reverse: true,
      firstEdition: false,
      blueprintId: '1',
      quantity: 1,
      raw: { properties_hash: { collector_number: '069/101' } },
    },
    {
      id: '200',
      name: 'Minun',
      condition: 'NM',
      language: 'EN',
      reverse: false,
      firstEdition: false,
      blueprintId: '2',
      quantity: 1,
      raw: { properties_hash: { collector_number: '70/101' } },
    },
  ];
  const pt = [
    {
      name: 'Plusle',
      collectorNumber: '69/101',
      condition: 'NM',
      language: 'EN',
      reverse: true,
      location: 'box1·3',
      quantity: 1,
    },
  ];
  const result = reconcilePowerToolsWithCardTrader(products, pt, 'pokemon');
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].location, 'box1·3');
  assert.equal(result.matched[0].product.id, '100');
  assert.equal(result.ctOnly.length, 1);
  assert.equal(result.ctOnly[0].product.id, '200');
  assert.equal(result.ptOnly.length, 0);
});

test('unmatched Power Tools rows stay ptOnly', () => {
  const result = reconcilePowerToolsWithCardTrader([], [{
    name: 'Orphan',
    collectorNumber: '1/1',
    condition: 'NM',
    language: 'EN',
    reverse: false,
    location: 'shelf',
    quantity: 2,
  }], 'pokemon');
  assert.equal(result.matched.length, 0);
  assert.equal(result.ptOnly.length, 1);
  assert.equal(result.ptOnly[0].location, 'shelf');
});

test('gamesFromCardTraderProducts groups supported games', () => {
  const games = gamesFromCardTraderProducts(
    [
      { id: '1', gameId: 5 },
      { id: '2', gameId: 5 },
      { id: '3', gameId: 15 },
      { id: '4', gameId: 999 },
    ],
    (product) => {
      if (product.gameId === 5) return 'pokemon';
      if (product.gameId === 15) return 'one_piece';
      return '';
    },
  );
  assert.deepEqual(games, [
    { id: 'pokemon', count: 2 },
    { id: 'one_piece', count: 1 },
  ]);
});
