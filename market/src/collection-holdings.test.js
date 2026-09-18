import assert from 'node:assert/strict';
import test from 'node:test';
import { isNftHolding, partitionHoldings, sumOwnedQuantity } from './collection-holdings.js';

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
