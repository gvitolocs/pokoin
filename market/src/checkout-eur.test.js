import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  packageTierForCount,
  quoteCheckout,
  groupCartBySeller,
  assertShipFromCountry,
} = require('../../server/pokoin-api/_checkout_core.js');

test('SPA can load checkout core for shipment grouping', () => {
  assert.throws(() => assertShipFromCountry('EU'));
  assert.equal(packageTierForCount(4), 'SMALL');
  assert.equal(packageTierForCount(5), 'MEDIUM');
  const groups = groupCartBySeller([
    { sellerUid: 'a', qty: 2 },
    { sellerUid: 'b', qty: 3 },
  ]);
  assert.equal(groups.length, 2);
  const quote = quoteCheckout({
    toCountry: 'IT',
    sellerOrigins: { a: 'DK', b: 'DE' },
    items: [
      { sellerUid: 'a', qty: 1, pricePkn: 200 },
      { sellerUid: 'b', qty: 5, pricePkn: 200 },
    ],
  });
  assert.equal(quote.shipments.length, 2);
  assert.ok(quote.grandTotalCents > quote.itemsSubtotalCents);
});
