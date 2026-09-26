import assert from 'node:assert/strict';
import test from 'node:test';
import { pickCartOffer } from './cart-offer.js';

const row = (pricePkn, condition, language, extra = {}) => ({
  id: `${language}-${condition}-${pricePkn}`,
  pricePkn,
  condition,
  language,
  quantityAvailable: 1,
  ...extra,
});

test('the cart takes the cheapest English Near Mint listing', () => {
  const pick = pickCartOffer([
    row(900, 'Near Mint', 'JP'),
    row(500, 'Near Mint', 'EN'),
    row(100, 'Lightly Played', 'EN'),
  ]);
  assert.equal(pick.id, 'EN-Near Mint-500');
});

test('without English Near Mint it keeps walking conditions, then languages', () => {
  assert.equal(pickCartOffer([
    row(50, 'Moderately Played', 'EN'),
    row(80, 'Lightly Played', 'EN'),
    row(10, 'Near Mint', 'JP'),
  ]).id, 'EN-Lightly Played-80');

  assert.equal(pickCartOffer([
    row(400, 'Played', 'JP'),
    row(220, 'Near Mint', 'JP'),
    row(180, 'Near Mint', 'ZH'),
  ]).id, 'ZH-Near Mint-180');

  assert.equal(pickCartOffer([
    row(70, 'Damaged', 'JP'),
    row(90, 'Played', 'JP'),
  ]).id, 'JP-Played-90');
});

test('a graded slab and an empty stack are not the cart pick', () => {
  assert.equal(pickCartOffer([
    row(1, 'Near Mint', 'EN', { graded: true }),
    row(40, 'Near Mint', 'EN', { quantityAvailable: 0 }),
    row(75, 'Near Mint', 'EN'),
  ]).id, 'EN-Near Mint-75');
});
