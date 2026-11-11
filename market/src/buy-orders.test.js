import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bestBid,
  bidsByCondition,
  crossesAsk,
  errorMessage,
  expiryLabel,
  selectionBid,
  orderStateLabel,
  validateBuyOrder,
} from './buy-orders.js';

const book = [
  { condition: 'NM', language: 'EN', reverse: false, first_edition: false, best_price_pkn: 120, quantity: 3, orders: 2 },
  { condition: 'NM', language: 'EN', reverse: true, first_edition: false, best_price_pkn: 150, quantity: 1, orders: 1 },
  { condition: 'SP', language: 'EN', reverse: false, first_edition: false, best_price_pkn: 90, quantity: 2, orders: 1 },
  { condition: 'NM', language: 'JP', reverse: false, first_edition: false, best_price_pkn: 80, quantity: 1, orders: 1 },
];

test('bestBid matches the whole facet tuple', () => {
  assert.equal(bestBid(book, { condition: 'NM', language: 'EN' }).best_price_pkn, 120);
  assert.equal(bestBid(book, { condition: 'NM', language: 'en', reverse: true }).best_price_pkn, 150);
  assert.equal(bestBid(book, { condition: 'NM', language: 'EN', firstEdition: true }), null);
  assert.equal(bestBid(book, { condition: 'PL', language: 'EN' }), null);
  assert.equal(bestBid(null, { condition: 'NM', language: 'EN' }), null);
});

test('bidsByCondition keeps the best price per condition for one language', () => {
  assert.deepEqual(bidsByCondition(book, 'EN'), [
    { condition: 'NM', bestPricePkn: 150, quantity: 1 },
    { condition: 'SP', bestPricePkn: 90, quantity: 2 },
  ]);
  assert.deepEqual(bidsByCondition(book, 'FR'), []);
  assert.deepEqual(bidsByCondition(undefined, 'EN'), []);
});

test('orderStateLabel names the four states', () => {
  assert.equal(orderStateLabel('open'), 'Open');
  assert.equal(orderStateLabel('filled'), 'Filled');
  assert.equal(orderStateLabel('expired'), 'Expired');
  assert.equal(orderStateLabel('cancelled'), 'Cancelled');
});

test('expiryLabel counts down and handles no expiry', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(expiryLabel(null, now), 'Until cancelled');
  assert.equal(expiryLabel('2026-11-14T12:00:00Z', now), '3 days left');
  assert.equal(expiryLabel('2026-11-12T13:00:00Z', now), '1 day left');
  assert.equal(expiryLabel('2026-11-11T17:00:00Z', now), '5 hours left');
  assert.equal(expiryLabel('2026-11-11T12:20:00Z', now), 'Less than an hour left');
  assert.equal(expiryLabel('2026-11-11T11:59:00Z', now), 'Expired');
});

test('validateBuyOrder mirrors the server rules', () => {
  const good = { card_id: 'c1', condition: 'NM', language: 'EN', price_pkn: 100, quantity: 2, days: 30 };
  assert.equal(validateBuyOrder(good).ok, true);
  assert.equal(validateBuyOrder({ ...good, days: null }).ok, true);
  assert.equal(validateBuyOrder({ ...good, days: 5 }).errors.days.length > 0, true);
  assert.ok(validateBuyOrder({ ...good, price_pkn: 0 }).errors.price_pkn);
  assert.ok(validateBuyOrder({ ...good, quantity: 11 }).errors.quantity);
  assert.ok(validateBuyOrder({ ...good, quantity: 1.5 }).errors.quantity);
  assert.ok(validateBuyOrder({ ...good, condition: 'Mint' }).errors.condition);
  assert.ok(validateBuyOrder({ ...good, language: 'XX' }).errors.language);
  assert.ok(validateBuyOrder({ ...good, card_id: '' }).errors.card_id);
});

test('errorMessage turns each code into a sentence', () => {
  for (const code of ['duplicate_buy_order', 'too_many_buy_orders', 'own_buy_order', 'not_open', 'quantity_exceeds_remaining']) {
    assert.match(errorMessage(code), /\.$/);
  }
  assert.match(errorMessage(new Error('not_open')), /no longer open/);
  assert.equal(errorMessage('Seller cannot list yet.'), 'Seller cannot list yet.');
  assert.match(errorMessage('something_odd'), /Something went wrong/);
  assert.match(errorMessage(''), /Something went wrong/);
});

test('crossesAsk is true at or above the cheapest listing', () => {
  assert.equal(crossesAsk(100, 100), true);
  assert.equal(crossesAsk(120, 100), true);
  assert.equal(crossesAsk(99, 100), false);
  assert.equal(crossesAsk(100, null), false);
  assert.equal(crossesAsk(100, 0), false);
});

test('selectionBid takes the top price across variants and sums the copies', () => {
  const row = selectionBid(book, { condition: 'NM', language: 'EN' });
  assert.equal(row.best_price_pkn, 150);
  assert.equal(row.quantity, 4);
  assert.equal(row.orders, 3);
  assert.equal(selectionBid(book, { condition: 'PL', language: 'EN' }), null);
});
