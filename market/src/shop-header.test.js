import assert from 'node:assert/strict';
import test from 'node:test';
import { SHOP_ICO } from './shop-icons.js';
import { isPriceSort, menuStep, nextPriceSort, priceArrow, SHOP_SORTS } from './shop-header.js';
import { sortOffers } from './card-desk.js';

test('the Price header toggles the two price orders and returns to lowest first from any other sort', () => {
  assert.equal(nextPriceSort('price'), 'price-desc');
  assert.equal(nextPriceSort('price-desc'), 'price');
  assert.equal(nextPriceSort('qty'), 'price');
  assert.equal(nextPriceSort('seller'), 'price');
  assert.equal(priceArrow('price'), 'up');
  assert.equal(priceArrow('price-desc'), 'down');
  assert.ok(isPriceSort('price') && isPriceSort('price-desc'));
  assert.ok(!isPriceSort('qty') && !isPriceSort('seller'));
});

test('every sort the old select offered is still a menu option and sorts', () => {
  assert.deepEqual(SHOP_SORTS.map((row) => row.value), ['price', 'price-desc', 'qty', 'seller']);
  const rows = [{ pricePkn: 5 }, { pricePkn: 9 }, { pricePkn: 1 }];
  assert.deepEqual(sortOffers(rows, nextPriceSort('price')).map((r) => r.pricePkn), [9, 5, 1]);
});

test('menu keys wrap around and ignore other keys', () => {
  assert.equal(menuStep('ArrowDown', 2, 3), 0);
  assert.equal(menuStep('ArrowUp', 0, 3), 2);
  assert.equal(menuStep('Home', 2, 3), 0);
  assert.equal(menuStep('End', 0, 3), 2);
  assert.equal(menuStep('a', 0, 3), -1);
  assert.equal(menuStep('ArrowDown', 0, 0), -1);
});

test('shop icons are single-path strings', () => {
  for (const [name, d] of Object.entries(SHOP_ICO)) {
    assert.match(d, /^M/, name);
    assert.ok(d.length > 10, name);
  }
});
