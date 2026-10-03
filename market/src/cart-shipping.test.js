import assert from 'node:assert/strict';
import test from 'node:test';
import { groupBySeller } from './cart-model.js';
import { orderServices, parcelEstimate, parcelNudge, parcelServices, shippingEstimate } from './cart-shipping.js';

const row = (over = {}) => ({
  id: 'l1',
  listingId: 'l1',
  cardId: '100',
  name: 'Umbreon VMAX',
  sellerUid: 'seller-a',
  sellerName: 'nez',
  sellerCountry: 'IT',
  condition: 'Near Mint',
  language: 'en',
  pricePkn: 2642,
  qty: 1,
  stock: 3,
  ...over,
});

test('a small parcel previews the untracked letter and the room left at that price', () => {
  // IT→DK: SMALL and MEDIUM letters cost the same (4.35 €), LARGE does not.
  const estimate = parcelEstimate({ from: 'IT', to: 'DK', cards: 2 });
  assert.equal(estimate.tracked, false);
  assert.equal(estimate.amountCents, 435);
  assert.equal(estimate.room, 18);
  assert.equal(parcelEstimate({ from: 'IT', to: 'DK', cards: 0 }), null);
  assert.equal(parcelEstimate({ from: 'EU', to: 'DK', cards: 1 }), null);
  assert.equal(parcelEstimate({ from: '', to: 'DK', cards: 1 }), null);
});

test('shipping estimate is one parcel per seller with ticked cards', () => {
  const groups = groupBySeller([
    row({ id: 'a', sellerUid: 's1', sellerCountry: 'IT', qty: 2 }),
    row({ id: 'b', sellerUid: 's2', sellerCountry: 'IT', selected: false }),
    row({ id: 'c', sellerUid: 's3', sellerCountry: '' }),
  ]);
  const estimate = shippingEstimate(groups, 'DK');
  assert.equal(estimate.count, 2);
  assert.equal(estimate.cents, 435);
  assert.equal(estimate.missing, 1);
  const nudge = parcelNudge(groups, 'DK');
  assert.equal(nudge.group.key, 's1');
  assert.equal(nudge.estimate.room, 18);
});

test('the buyer can pick tracked; an unknown service falls back to the default', () => {
  const tracked = parcelEstimate({ from: 'IT', to: 'DK', cards: 2, service: 'tracked' });
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.serviceId, 'tracked');
  assert.equal(tracked.fallback, false);
  const odd = parcelEstimate({ from: 'IT', to: 'DK', cards: 2, service: 'pigeon' });
  assert.equal(odd.serviceId, 'untracked');
  assert.equal(odd.fallback, true);
  const services = parcelServices({ from: 'IT', to: 'DK', cards: 2 });
  assert.ok(services.length >= 2);
  assert.ok(services.every((option) => !option.unavailable));
});

test('order services total each choice across parcels', () => {
  const groups = groupBySeller([
    row({ id: 'a', sellerUid: 's1', sellerCountry: 'IT', qty: 2 }),
    row({ id: 'b', sellerUid: 's2', sellerCountry: 'DE' }),
  ]);
  const services = orderServices(groups, 'DK');
  const untracked = services.find((option) => option.id === 'untracked');
  const tracked = services.find((option) => option.id === 'tracked');
  assert.ok(untracked && tracked);
  assert.equal(untracked.parcels, 2);
  assert.equal(
    tracked.cents,
    parcelEstimate({ from: 'IT', to: 'DK', cards: 2, service: 'tracked' }).amountCents
      + parcelEstimate({ from: 'DE', to: 'DK', cards: 1, service: 'tracked' }).amountCents,
  );
  const total = shippingEstimate(groups, 'DK', 'tracked');
  assert.equal(total.cents, tracked.cents);
});
