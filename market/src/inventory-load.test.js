import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('inventory top-up uses the bearer from the same callback', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(root, 'pages/Inventory.jsx'), 'utf8');
  assert.match(
    src,
    /then\(async \(token\) => \{[\s\S]*fetchSellerListings\(listingsUid, token[\s\S]*topUpInventory\(listingsUid, token, gen\)/,
  );
  assert.doesNotMatch(
    src,
    /\.then\(\(data\) => \{[\s\S]*topUpInventory\(listingsUid, token/,
  );
});

test('inventory first page survives a late uid and retries a stalled load', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(root, 'pages/Inventory.jsx'), 'utf8');
  // The cached session uid and the restored Firebase uid are one key, so the
  // second arriving does not cancel the first request.
  assert.match(src, /const listingsUid = signedIn \? \(user\?\.uid \|\| profile\?\.uid \|\| ''\) : '';/);
  assert.match(src, /\}, \[listingsUid, getBearer, onImportTab, locationName, onSettingsTab, onCollectionTab\]\);/);
  assert.doesNotMatch(src, /\}, \[signedIn, user\?\.uid, profile\?\.uid, getBearer/);
  // A stalled token refresh or request is asked again; the first answer wins.
  assert.match(src, /setTimeout\(\(\) => \{\s*if \(!cancelled && !settled\) attempt\(\)\.catch\(fail\);\s*\}, INVENTORY_RETRY_MS\)/);
  assert.match(src, /clearTimeout\(retry\)/);
});
