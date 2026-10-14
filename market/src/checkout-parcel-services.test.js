import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { groupBySeller } from './cart-model.js';
import { mergeShippingChoice } from './cart-row-edits.js';
import {
  checkoutParcelShipping,
  checkoutSellerParcels,
  checkoutShippingPreviewCents,
} from './checkout-model.js';
import { liveShippingTotals } from './live-shipping.js';
import { readParcelServices, writeParcelServices } from './shipping-choice.js';
import { previewShipment } from './shipping-quote.js';

// Two sellers, one parcel each: redshakkio ships from Italy, givi from Denmark.
const cartRows = [
  { id: '1', listingId: 'l1', sellerUid: 'red', sellerName: 'redshakkio', sellerCountry: 'IT', pricePkn: 200, qty: 1 },
  { id: '2', listingId: 'l2', sellerUid: 'givi', sellerName: 'givi', sellerCountry: 'DK', pricePkn: 400, qty: 2 },
];

function cents(from, count, tracked) {
  return previewShipment({ fromCountry: from, toCountry: 'DK', cardCount: count, tracked }).amountCents;
}

test('cart parcel picks carry into checkout and price each parcel on its own service', () => {
  // The cart keys a parcel by seller uid; checkout groups by the same uid.
  const choice = mergeShippingChoice(
    mergeShippingChoice({ country: 'DK', service: '', parcels: {} }, { parcel: { key: 'red', service: 'untracked' } }),
    { parcel: { key: 'givi', service: 'tracked' } },
  );
  const groups = groupBySeller(cartRows);
  const cart = liveShippingTotals({
    liveByKey: new Map(), ticked: groups, country: 'DK', activeService: '', allowUntracked: true, parcelPicks: choice.parcels,
  });

  const shipping = checkoutParcelShipping({
    nft: false,
    sellerParcels: checkoutSellerParcels(cartRows),
    buyerCountry: 'DK',
    allowUntracked: true,
    picks: choice.parcels,
  });
  assert.deepEqual(shipping.services, { red: 'untracked', givi: 'tracked' });
  assert.deepEqual(
    shipping.parcels.map((p) => [p.sellerId, p.from, p.serviceId]),
    [['red', 'IT', 'untracked'], ['givi', 'DK', 'tracked']],
  );
  assert.equal(shipping.cents, cents('IT', 1, false) + cents('DK', 2, true));
  // Same services and total as the cart showed.
  assert.deepEqual(cart.parcels.map((p) => p.estimate.serviceId), ['untracked', 'tracked']);
  assert.equal(shipping.cents, cart.cents);
  // The rate-table preview before the quote lands agrees too.
  assert.equal(checkoutShippingPreviewCents({
    nft: false, itemCount: 2, quote: null, sellerParcels: checkoutSellerParcels(cartRows),
    buyerCountry: 'DK', tracked: true, services: shipping.services,
  }), shipping.cents);
});

test('without a parcel pick checkout uses the order service where the lane has it', () => {
  const sellerParcels = checkoutSellerParcels(cartRows);
  const base = { nft: false, sellerParcels, buyerCountry: 'DK', allowUntracked: true };
  const tracked = checkoutParcelShipping({ ...base, service: 'tracked' });
  assert.deepEqual(tracked.services, { red: 'tracked', givi: 'tracked' });
  const mixed = checkoutParcelShipping({ ...base, service: 'tracked', picks: { red: 'untracked' } });
  assert.deepEqual(mixed.services, { red: 'untracked', givi: 'tracked' });
  // No pick at all: the cheapest service every parcel offers.
  const cheapest = checkoutParcelShipping(base);
  assert.equal(cheapest.missing, 0);
  assert.equal(new Set(Object.values(cheapest.services)).size, 1);
});

test('checkout never books an untracked letter above €20 or a Packlink service', () => {
  const sellerParcels = checkoutSellerParcels(cartRows);
  const capped = checkoutParcelShipping({
    nft: false, sellerParcels, buyerCountry: 'DK', allowUntracked: false, picks: { red: 'untracked', givi: 'packlink:22131' },
  });
  assert.deepEqual(capped.services, { red: 'tracked', givi: 'tracked' });
  assert.deepEqual(capped.parcels.map((p) => p.fallback), [true, true]);
  assert.ok(capped.parcels.every((p) => p.options.every((o) => o.id === 'tracked')));
  assert.deepEqual(checkoutParcelShipping({ nft: true, sellerParcels, buyerCountry: 'DK' }).services, {});
});

test('stored parcel picks keep bookable services only', () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    writeParcelServices({ red: 'untracked', givi: 'packlink:22131', x: 'pigeon' });
    assert.deepEqual(readParcelServices(), { red: 'untracked' });
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('the checkout preview table prices like the API rate table', () => {
  const spa = JSON.parse(readFileSync(new URL('./shipping-rates.json', import.meta.url), 'utf8'));
  const api = JSON.parse(readFileSync(
    new URL('../../pokoin-rust/crates/commerce/assets/shipping-rates.json', import.meta.url),
    'utf8',
  ));
  const fields = (rate) => ['id', 'fromCountry', 'toCountry', 'packageTier', 'priceEURCents', 'active', 'tracked']
    .map((key) => rate[key]);
  const rows = (catalog) => catalog.rates.map(fields).map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(rows(spa), rows(api));
  assert.deepEqual(spa.tiers, api.tiers);
});
