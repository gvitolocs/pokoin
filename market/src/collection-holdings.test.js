import assert from 'node:assert/strict';
import test from 'node:test';
import { isNftHolding, partitionHoldings, splitOwnedDesk, suggestedHoldingAsk, sumOwnedQuantity } from './collection-holdings.js';

test('suggestedHoldingAsk uses the cheapest Pokoin listing', () => {
  const ask = suggestedHoldingAsk(
    { '244538': { pokoinCheapestPkn: 86.4, soldMedianPkn: 40 } },
    { cardId: '244538', condition: 'NM', language: 'EN' },
  );
  assert.equal(ask, '86');
  assert.equal(suggestedHoldingAsk({}, { cardId: '1' }), '');
});

test('sumOwnedQuantity sums quantity, ignores junk', () => {
  assert.equal(sumOwnedQuantity([{ quantity: 2 }, { quantity: 3 }, { quantity: 0 }, {}]), 5);
});

test('partitionHoldings separates physical and NFT', () => {
  const { physical, nft, ownedCards } = partitionHoldings([
    { id: 'a', quantity: 2, ownershipType: 'physical' },
    { id: 'b', quantity: 1, ownershipType: 'nft', nftStatus: 'owned' },
    { id: 'c', quantity: 1, fulfillmentMode: 'nft_only' },
  ]);
  assert.equal(physical.length, 1);
  assert.equal(nft.length, 2);
  assert.equal(ownedCards, 4);
  assert.equal(isNftHolding(physical[0]), false);
  assert.equal(isNftHolding(nft[0]), true);
});

test('splitOwnedDesk keeps unlisted holdings on the left and live listings on the right', () => {
  const { held, listed } = splitOwnedDesk(
    [
      { id: 'hold-a', cardId: '10', quantity: 1, ownershipType: 'physical' },
      { id: 'hold-b', cardId: '11', quantity: 1, listingId: 'list-b', ownershipType: 'physical' },
      { id: 'nft-1', cardId: '12', quantity: 1, ownershipType: 'nft' },
    ],
    [
      { id: 'list-b', cardId: '11', status: 'active', quantityAvailable: 1, pricePkn: 40 },
      { id: 'list-c', cardId: '99', status: 'paused', quantityAvailable: 2, pricePkn: 8 },
      { id: 'dead', cardId: '10', status: 'inactive', quantityAvailable: 1 },
    ],
  );
  assert.deepEqual(held.map((row) => row.holding.id), ['hold-a', 'nft-1']);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].listing.id, 'list-b');
  assert.equal(listed[0].holding.id, 'hold-b');
  assert.equal(listed[1].kind, 'listing');
  assert.equal(listed[1].listing.id, 'list-c');
});

test('splitOwnedDesk pairs a new listing back to the holding it came from', () => {
  const { held, listed } = splitOwnedDesk(
    [
      { id: 'scan:1', cardId: '10', quantity: 1 },
      { id: 'scan:2', cardId: '10', quantity: 1 },
    ],
    [
      { id: 'list-1', cardId: '10', status: 'active', quantityAvailable: 1, sourceListingId: 'scan:1' },
    ],
  );
  assert.equal(held.length, 1);
  assert.equal(held[0].holding.id, 'scan:2');
  assert.equal(listed[0].holding.id, 'scan:1');
});
