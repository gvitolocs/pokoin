import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./Inventory.jsx', import.meta.url), 'utf8');
const nav = fs.readFileSync(new URL('../components/StockNav.jsx', import.meta.url), 'utf8');

test('inventory top-up uses the bearer from the same callback', () => {
  assert.match(
    src,
    /getBearer\(\)\.then\(async \(token\) => \{[\s\S]*fetchSellerListings\(uid, token[\s\S]*topUpInventory\(uid, token, gen\)/,
  );
  assert.doesNotMatch(src, /\.then\(\(data\) => \{[\s\S]*topUpInventory\(uid, token/);
});

test('inventory first page survives a late uid and retries a stalled load', () => {
  // The cached session uid and the restored Firebase uid are one key, so the
  // second arriving does not cancel the first request.
  assert.match(src, /const listingsUid = createMemo\(\(\) => \(signedIn\(\) \? authUid\(\) \|\| accountProfile\(\)\?\.uid \|\| '' : ''\)\);/);
  assert.match(src, /createEffect\(\s*\(\) => \(\{ uid: listingsUid\(\), \.\.\.tab\(\) \}\),/);
  // A stalled token refresh or request is asked again; the first answer wins.
  assert.match(src, /setTimeout\(\(\) => \{\s*if \(!cancelled && !settled\) attempt\(\)\.catch\(fail\);\s*\}, INVENTORY_RETRY_MS\)/);
  assert.match(src, /clearTimeout\(retry\)/);
});

test('holdings are the MyPokoin Collection tab, which loads holdings only', () => {
  assert.match(nav, /\{ to: '\/mypokoin\/collection', label: 'Collection', end: true \}/);
  assert.match(src, /<Show when=\{tab\(\)\.collectionTab\}><CollectionHoldings \/><\/Show>/);
  // No listings or pricer round trip on the Collection tab.
  assert.match(src, /if \(!uid \|\| collectionTab\) return undefined;/);
  assert.match(src, /\(\) => signedIn\(\) && !tab\(\)\.importTab && !tab\(\)\.collectionTab,/);
});
