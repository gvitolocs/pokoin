import assert from 'node:assert/strict';
import test from 'node:test';
import { applyListingLive, listingLiveUrl } from './listing-live.js';

test('listing live url is the card desk stream', () => {
  assert.equal(listingLiveUrl('693360'), '/api/marketplace-live?cardId=693360');
});

test('a listing frame updates only that ask', () => {
  const offers = [
    { id: '1', quantityAvailable: 4, status: 'active' },
    { id: '2', quantityAvailable: 1, status: 'active' },
  ];
  const next = applyListingLive(offers, {
    listingId: '1',
    quantityAvailable: 3,
    status: 'active',
  });
  assert.equal(next[0].quantityAvailable, 3);
  assert.equal(next[1], offers[1]);
  assert.equal(applyListingLive(next, {
    listingId: '1',
    quantityAvailable: 3,
    status: 'active',
  }), next);
});
