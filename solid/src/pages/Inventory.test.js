import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./Inventory.jsx', import.meta.url), 'utf8');
const nav = fs.readFileSync(new URL('../components/StockNav.jsx', import.meta.url), 'utf8');

test('inventory uses one scoped private book and ignores disposed page updates', () => {
  assert.match(src, /inventoryBooks.load\(uid, selectedGame/);
  assert.match(src, /fetchSellerListings\(uid, await getBearer\(\), \{ \.\.\.page, game: selectedGame, order: 'price-desc' \}\)/);
  assert.match(src, /if \(cancelled\) return;/);
  assert.match(src, /inventoryBooks.invalidate\(uid, selectedGame\)/);
});

test('holdings are the MyPokoin Collection tab, which loads holdings only', () => {
  assert.match(nav, /\{ to: '\/mypokoin\/collection', label: 'Collection', end: true/);
  assert.match(src, /<Show when=\{tab\(\)\.collectionTab\}><CollectionHoldings/);
  // No listings or pricer round trip on the Collection tab.
  assert.match(src, /if \(!uid \|\| collectionTab\) return undefined;/);
  assert.match(src, /\(\) => \(!tab\(\)\.importTab && !tab\(\)\.collectionTab \? listingsUid\(\) : ''\),/);
});

test('a revisit paints the stored book before Firebase answers and revalidates with the stamp', () => {
  assert.match(src, /<SignedIn early from=/);
  assert.match(src, /fetchStamp: async \(\) => fetchSellerListingsStamp\(uid, await getBearer\(\), \{ game: selectedGame \}\)/);
  assert.match(src, /readCachedPricerSettings\(untrack\(listingsUid\)\)/);
  assert.match(src, /writeCachedPricerSettings\(uid, settings\)/);
});
