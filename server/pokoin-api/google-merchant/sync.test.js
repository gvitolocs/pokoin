'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { quoteShipment } = require('../_checkout_core');
const { backoffSeconds } = require('./client');
const { merchantConfig } = require('./config');
const { reconcileProducts } = require('./reconcile');
const { shippingOptionsForListing } = require('./shipping');
const { syncListingEvent } = require('./sync');

const image = 'https://cdn.pokoin.com/cards/239000.jpg';

function listing(overrides = {}) {
  return {
    id: 'lst-a',
    cardId: '239000',
    sellerUid: 'seller-a',
    sellerName: 'Seller A',
    sellerCountry: 'DE',
    condition: 'NM',
    pricePkn: 64000,
    quantityAvailable: 1,
    status: 'active',
    shippingAvailable: true,
    cardName: 'Charizard',
    cardImageUrl: image,
    setName: 'Base Set',
    collectorNumber: '4/102',
    canonicalPath: '/marketplace/en/cards/239000/card-charizard-4-102-base-set',
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    ...merchantConfig({
      GOOGLE_MERCHANT_ENABLED: '1',
      GOOGLE_MERCHANT_DRY_RUN: '1',
      GOOGLE_MERCHANT_COUNTRIES: 'DK,IT',
      GOOGLE_MERCHANT_CURRENCIES: 'EUR,DKK',
    }),
    ...overrides,
  };
}

test('display cents match checkout eurCentsFromPkn', async () => {
  const { eurCentsFromPkn: checkout } = require('../_checkout_core');
  const { eurCentsFromPkn: display } = await import('../../../market/src/pkn.js');
  for (const pkn of [1, 20, 200, 19800, 21000, 64000]) {
    assert.equal(display(pkn), checkout(pkn));
  }
});

test('dry-run merchant sync is idempotent and follows shipping quotes', async () => {
  const calls = [];
  const client = {
    async upsertProduct(input) {
      calls.push(input.offerId);
      return { dryRun: true, offerId: input.offerId };
    },
    async deleteProduct({ offerId }) {
      calls.push(`delete:${offerId}`);
      return { dryRun: true, offerId };
    },
  };
  const payload = { mutation: 'LISTING_CREATED', merchantListing: listing() };
  const first = await syncListingEvent(payload, { config: config(), client, recordStatus: async () => {} });
  const second = await syncListingEvent(payload, { config: config(), client, recordStatus: async () => {} });
  assert.deepEqual(first.results.map((row) => row.offerId), ['pokoin-lst-a-EUR', 'pokoin-lst-a-DKK']);
  assert.deepEqual(second.results.map((row) => row.offerId), first.results.map((row) => row.offerId));
  assert.deepEqual(calls, [
    'pokoin-lst-a-EUR',
    'pokoin-lst-a-DKK',
    'pokoin-lst-a-EUR',
    'pokoin-lst-a-DKK',
  ]);
  const eur = first.results.find((row) => row.currency === 'EUR');
  const dkk = first.results.find((row) => row.currency === 'DKK');
  assert.equal(eur.display.amount, '320.00');
  assert.equal(eur.stripe.amountCents, 32000);
  assert.equal(eur.stripe.currency, 'EUR');
  assert.equal(dkk.display.amount, '2400.00');
  assert.equal(dkk.stripe.amountCents, 32000);
  assert.equal(eur.input.productAttributes.link.includes('currency=EUR'), true);
  assert.equal(eur.canonical.includes('currency='), false);
  assert.equal(eur.input.productAttributes.shipping[0].country, 'IT');
  assert.equal(eur.input.productAttributes.shipping[0].price.amountMicros, '6990000');
  assert.equal(dkk.input.productAttributes.shipping[0].country, 'DK');
  assert.equal(dkk.input.productAttributes.condition, 'USED');
  const quoted = quoteShipment({
    sellerId: 'seller-a',
    fromCountry: 'DE',
    toCountry: 'IT',
    items: [{ quantity: 1 }],
  });
  assert.equal(quoted.amountCents, 699);
  assert.equal(quoted.currency, 'EUR');
});

test('a sold listing queues removal and drops the aggregate', async () => {
  const deleted = [];
  const client = {
    async upsertProduct() {
      throw new Error('sold listings must not be upserted');
    },
    async deleteProduct({ offerId }) {
      deleted.push(offerId);
      return { dryRun: true };
    },
  };
  const result = await syncListingEvent({
    mutation: 'LISTING_SOLD',
    merchantListing: listing({ status: 'sold_out', quantityAvailable: 0 }),
  }, { config: config(), client, recordStatus: async () => {} });
  assert.deepEqual(deleted, ['pokoin-lst-a-EUR', 'pokoin-lst-a-DKK']);
  assert.deepEqual(result.results.map((row) => row.reason), ['NOT_ACTIVE', 'NOT_ACTIVE']);
  const shipping = await shippingOptionsForListing(listing({ sellerCountry: 'ZZ' }), {
    currency: 'EUR',
    countries: ['IT'],
  });
  assert.deepEqual(shipping, []);
});

test('reconciliation finds missing, stale, and wrong prices without writing', () => {
  const diff = reconcileProducts(
    [{
      offerId: 'pokoin-lst-a-EUR',
      amountMicros: '320000000',
      currency: 'EUR',
      externalSellerId: 'seller-a',
    }],
    [
      {
        offerId: 'pokoin-lst-a-EUR',
        productAttributes: {
          availability: 'OUT_OF_STOCK',
          externalSellerId: 'seller-a',
          price: { amountMicros: '105000000', currencyCode: 'EUR' },
        },
      },
      { offerId: 'pokoin-old-EUR', productAttributes: { availability: 'IN_STOCK', price: { amountMicros: '1', currencyCode: 'EUR' } } },
    ],
  );
  assert.deepEqual(diff.stale, ['pokoin-lst-a-EUR']);
  assert.deepEqual(diff.priceMismatch, ['pokoin-lst-a-EUR']);
  assert.deepEqual(diff.extra, ['pokoin-old-EUR']);
  assert.deepEqual(diff.missing, []);
  assert.equal(backoffSeconds(1), 30);
  assert.equal(backoffSeconds(3), 120);
  assert.equal(merchantConfig({}).enabled, false);
  assert.equal(merchantConfig({ GOOGLE_MERCHANT_ENABLED: '1' }).dryRun, true);
  assert.equal(merchantConfig({ GOOGLE_MERCHANT_ENABLED: '1', GOOGLE_MERCHANT_DRY_RUN: '0' }).dryRun, false);
});
