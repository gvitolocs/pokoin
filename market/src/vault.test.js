import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDeal } from './card-desk.js';
import { isVaultOffer, splitVaultOffers, VAULT_DEAL_LINE, VAULT_SELLER_UID } from './vault.js';

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

test('the Best Deal is a Vault item only when the cheapest matching offer is the Vault\'s', () => {
  const vault = { id: 'v', sellerUid: VAULT_SELLER_UID, pricePkn: 17, condition: 'NM', language: 'EN' };
  const seller = { id: 's', sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2', pricePkn: 22, condition: 'NM', language: 'EN' };
  assert.equal(isVaultOffer(matchDeal([seller, vault], 'EN', 'NM')), true);
  assert.equal(isVaultOffer(matchDeal([seller, { ...vault, pricePkn: 30 }], 'EN', 'NM')), false);
  // A Vault copy in another grade does not make the NM deal a Vault one.
  assert.equal(isVaultOffer(matchDeal([seller, { ...vault, condition: 'PL' }], 'EN', 'NM')), false);
  assert.equal(VAULT_DEAL_LINE, 'Available in the Vault');
});
