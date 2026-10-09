import assert from 'node:assert/strict';
import test from 'node:test';
import './session-storage-test-polyfill.js';
import { artistCardCount, languageMatches, rarityMatches, satelliteGroups } from './browse-hubs.js';
import { exploreLanguages, filterExploreItems } from './explore-filter.js';
import { isOneDayReady, sellerFiltersNarrow, sellerFromPayload, sellerOfferRow } from './seller-shop.js';
import { LANGUAGE_HUBS, rarityFromSlug } from './seo.js';

test('satellite sets: one A → Z group, filtered by name or slug', () => {
  const rows = [{ name: 'Zeta', slug: 'zeta' }, { name: 'Alpha', slug: 'a-1' }, { name: 'Mid', slug: 'mid' }];
  assert.deepEqual(satelliteGroups(rows).map(([heading, list]) => [heading, list.map((row) => row.name)]), [
    ['Sets', ['Alpha', 'Mid', 'Zeta']],
  ]);
  assert.deepEqual(satelliteGroups(rows, 'a-1')[0][1].map((row) => row.name), ['Alpha']);
  assert.deepEqual(satelliteGroups(rows, 'nothing'), []);
});

test('rarity hub membership: exact slug, promo and full-art loosely', () => {
  assert.equal(rarityMatches({ rarity: 'Illustration Rare' }, rarityFromSlug('illustration-rare')), true);
  assert.equal(rarityMatches({ rarity: 'Black Star Promo' }, rarityFromSlug('promo')), true);
  assert.equal(rarityMatches({ rarity: 'Common' }, rarityFromSlug('rare')), false);
  assert.equal(rarityMatches({}, rarityFromSlug('rare')), false);
});

test('language hub membership: English takes every western print bucket', () => {
  const english = LANGUAGE_HUBS.find((row) => row.slug === 'english');
  const japanese = LANGUAGE_HUBS.find((row) => row.slug === 'japanese');
  assert.equal(languageMatches({ nationality: 'american' }, english), true);
  assert.equal(languageMatches({ nationality: 'japanese' }, english), false);
  assert.equal(languageMatches({ nationality: 'japanese' }, japanese), true);
});

test('artist card count reads count or cardCount', () => {
  assert.equal(artistCardCount({ count: '12' }), 12);
  assert.equal(artistCardCount({ cardCount: 3 }), 3);
  assert.equal(artistCardCount(null), 0);
});

test('explore filter: facets, watch list and sorts', () => {
  const catalog = {
    items: [
      { id: 1, name: 'Pikachu', expansion: 'Base', game: 'pokemon', language: 'EN', pricePkn: 10, totalPkn: 30, qty: 3 },
      { id: 2, name: 'Booster', expansion: 'Base', game: 'pokemon', language: 'JP', pricePkn: 500, totalPkn: 500, qty: 1, sealed: true },
      { id: 3, name: 'Eevee', expansion: 'Jungle', game: 'pokemon', language: 'EN', pricePkn: 50, totalPkn: 100, qty: 2 },
    ],
  };
  assert.deepEqual(exploreLanguages(catalog), ['EN', 'JP']);
  assert.deepEqual(filterExploreItems(catalog).map((row) => row.id), [2, 3, 1]);
  assert.deepEqual(filterExploreItems(catalog, { sort: 'name' }).map((row) => row.id), [2, 3, 1]);
  assert.deepEqual(filterExploreItems(catalog, { sort: 'qty' }).map((row) => row.id), [1, 3, 2]);
  assert.deepEqual(filterExploreItems(catalog, { type: 'cards', max: '60' }).map((row) => row.id), [3, 1]);
  assert.deepEqual(filterExploreItems(catalog, { watchOnly: true, watched: ['3'] }).map((row) => row.id), [3]);
  assert.deepEqual(filterExploreItems(catalog, { langs: new Set(['JP']) }).map((row) => row.id), [2]);
  assert.deepEqual(filterExploreItems(null), []);
});

test('seller shop: narrow filters, 1-Day Ready, identity and offer rows', () => {
  assert.equal(sellerFiltersNarrow({}), false);
  assert.equal(sellerFiltersNarrow({ query: '  ' }), false);
  assert.equal(sellerFiltersNarrow({ sort: 'name' }), true);
  assert.equal(sellerFiltersNarrow({ page: 2 }), true);
  assert.equal(isOneDayReady({ shippingMode: 'one_day_ready' }), true);
  assert.equal(isOneDayReady({}), false);

  const seller = sellerFromPayload(
    { seller: { uid: 'u1', username: '@shop', displayName: 'Shop Name', associate: { role: 'Founder' } } },
    'shop',
    null,
  );
  assert.equal(seller.uid, 'u1');
  assert.equal(seller.username, 'shop');
  assert.equal(seller.displayName, 'Shop Name');
  assert.deepEqual(seller.associate, { role: 'founder', displayName: '' });
  // A username echoed as displayName keeps the name an earlier page painted.
  const kept = sellerFromPayload({ seller: { username: 'shop', displayName: 'shop' } }, 'shop', null, seller);
  assert.equal(kept.displayName, 'Shop Name');
  assert.equal(kept.uid, 'u1');

  const { cardId, enriched, cardStub } = sellerOfferRow({ id: 'o1', cardId: 42, cardName: 'Pikachu' }, 'en');
  assert.equal(cardId, '42');
  assert.equal(enriched.id, 'o1');
  assert.equal(cardStub.name, 'Pikachu');
  assert.match(cardStub.canonicalPath, /\/cards\/42/);
});
