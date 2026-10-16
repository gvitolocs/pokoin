import test from 'node:test';
import assert from 'node:assert/strict';
import { isVaultOffer, splitVaultOffers, VAULT_SELLER_UID } from './vault.js';

test('vault offers are the admin account, in order; everything else stays in the shop', () => {
  const offers = [
    { id: 'a', sellerUid: 'someone' },
    { id: 'b', sellerUid: VAULT_SELLER_UID },
    { id: 'c', seller_uid: VAULT_SELLER_UID },
    { id: 'd' },
  ];
  const { vault, shop } = splitVaultOffers(offers);
  assert.deepEqual(vault.map((o) => o.id), ['b', 'c']);
  assert.deepEqual(shop.map((o) => o.id), ['a', 'd']);
  assert.equal(isVaultOffer(null), false);
  assert.deepEqual(splitVaultOffers(undefined), { vault: [], shop: [] });
});
