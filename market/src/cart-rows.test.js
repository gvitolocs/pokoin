import assert from 'node:assert/strict';
import test from 'node:test';
import { addCartRow, cartItemFromOffer, dropSavedRow } from './cart-rows.js';

const card = { id: '703382', name: 'Pikachu', set: 'Base Set', canonicalPath: '/marketplace/en/cards/703382/pikachu' };
const offer = { id: 'L1', pricePkn: 120, quantityAvailable: 3, condition: 'NM', language: 'EN', sellerName: 'Ash' };

test('a shop offer becomes one selected cart row priced in PKN', () => {
  const row = cartItemFromOffer(card, offer);
  assert.equal(row.id, 'L1');
  assert.equal(row.listingId, 'L1');
  assert.equal(row.cardId, '703382');
  assert.equal(row.pricePkn, 120);
  assert.equal(row.addedPricePkn, 120);
  assert.equal(row.qty, 1);
  assert.equal(row.stock, 3);
  assert.equal(row.selected, true);
  assert.equal(row.href, card.canonicalPath);
  assert.equal(row.setName, 'Base Set');
});

test('adding the same listing tops up its qty up to stock instead of a second row', () => {
  const first = cartItemFromOffer(card, offer);
  let rows = addCartRow([], first);
  rows = addCartRow(rows, { ...first, qty: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 3);
  const other = cartItemFromOffer(card, { ...offer, id: 'L2' });
  rows = addCartRow(rows, other);
  assert.deepEqual(rows.map((row) => row.id), ['L2', 'L1']);
});

test('a re-added saved copy leaves Saved for later', () => {
  const saved = [{ id: 'L1' }, { id: 'L9' }];
  assert.deepEqual(dropSavedRow(saved, 'L1'), [{ id: 'L9' }]);
  assert.equal(dropSavedRow(saved, 'L7'), saved);
});
