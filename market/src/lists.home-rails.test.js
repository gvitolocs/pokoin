import assert from 'node:assert/strict';
import test from 'node:test';
import { HOME_RAIL, mergeHomeRail } from './lists.js';

test('HOME_RAIL maps the three homepage carousels to dedicated paths', () => {
  assert.equal(HOME_RAIL.newCards.path, '/api/marketplace-home/new-cards');
  assert.equal(HOME_RAIL.bestSellers.path, '/api/marketplace-home/best-sellers');
  assert.equal(HOME_RAIL.spotlight.path, '/api/marketplace-home/spotlight');
  assert.equal(HOME_RAIL.newCards.legacyId, 'new_cards');
  assert.equal(HOME_RAIL.bestSellers.legacyId, 'best_sellers');
  assert.equal(HOME_RAIL.spotlight.legacyId, 'featured');
  assert.equal(HOME_RAIL.spotlight.sectionKey, 'featuredIds');
});

test('mergeHomeRail paints one rail without wiping the others', () => {
  const first = mergeHomeRail(null, {
    sectionKey: 'newArrivalIds',
    limit: 20,
    cards: [
      { id: '1', name: 'A', set: 'Storm Emeralda', card_number: '1/10', productType: 'card', itemKind: 'single' },
    ],
  });
  assert.deepEqual(first.sections.newArrivalIds, ['1']);
  assert.equal(first.cards.length, 1);

  const second = mergeHomeRail(first, {
    sectionKey: 'bestSellerIds',
    limit: 12,
    cards: [
      { id: '2', name: 'B', set: 'Surging Sparks', card_number: '2/10', productType: 'card', itemKind: 'single' },
    ],
  });
  assert.deepEqual(second.sections.newArrivalIds, ['1']);
  assert.deepEqual(second.sections.bestSellerIds, ['2']);
  assert.equal(second.cards.length, 2);
});
