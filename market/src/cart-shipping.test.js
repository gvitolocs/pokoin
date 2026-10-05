import assert from 'node:assert/strict';
import test from 'node:test';
import { groupBySeller } from './cart-model.js';
import { nudgeFromParcels, orderServices, parcelEstimate, parcelNudge, parcelServices, shippingEstimate, tierRoom } from './cart-shipping.js';

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

test('a small parcel previews Postamail Internazionale and the room left at that price', () => {
  // IT→DK: SMALL is Postamail Normalizzato €1.30; MEDIUM jumps to the 100 g band.
  // Domestic Posta Ordinaria is a different product/table (IT→IT).
  const estimate = parcelEstimate({ from: 'IT', to: 'DK', cards: 2 });
  assert.equal(estimate.tracked, false);
  assert.equal(estimate.amountCents, 130);
  assert.equal(estimate.serviceName, 'Postamail Internazionale');
  assert.equal(estimate.room, 2); // same €1.30 only through SMALL (max 4)
  const domestic = parcelEstimate({ from: 'IT', to: 'IT', cards: 2 });
  assert.equal(domestic.serviceName, 'Posta Ordinaria');
  assert.equal(domestic.amountCents, 130);
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
  assert.equal(estimate.cents, 130);
  assert.equal(estimate.missing, 1);
  const nudge = parcelNudge(groups, 'DK');
  assert.equal(nudge.group.key, 's1');
  assert.equal(nudge.estimate.room, 2);
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

test('tier room is the room left in the tier that fits the cards', () => {
  assert.equal(tierRoom(2), 2); // SMALL max 4
  assert.equal(tierRoom(4), 0); // at the SMALL cap
  assert.equal(tierRoom(5), 15); // MEDIUM max 20
  assert.equal(tierRoom(79), 121); // LARGE max 200
  assert.equal(tierRoom(0), 0);
  assert.equal(tierRoom(9999), 0); // at the EXTRA_LARGE cap
  assert.equal(tierRoom(10000), 0); // no tier covers it
});

test('the nudge picks the dearest parcel that still has room', () => {
  const groups = [
    { key: 'a', sellerCountry: 'IT', selectedCount: 2 },
    { key: 'b', sellerCountry: 'DE', selectedCount: 5 },
  ];
  const parcels = [
    { key: 'a', estimate: { amountCents: 130, room: 2 } },
    { key: 'b', estimate: { amountCents: 9525, room: 15 } },
  ];
  const best = nudgeFromParcels(groups, parcels);
  assert.equal(best.group.key, 'b');
  assert.equal(best.estimate.amountCents, 9525);
  assert.equal(best.estimate.room, 15);
  // A parcel with no room is skipped even when dearest; so is a null estimate.
  const stuck = nudgeFromParcels(groups, [
    { key: 'b', estimate: { amountCents: 9525, room: 0 } },
    { key: 'a', estimate: null },
  ]);
  assert.equal(stuck, null);
  const none = nudgeFromParcels(groups, [
    { key: 'a', estimate: { amountCents: 130, room: 0 } },
    { key: 'b', estimate: { amountCents: 9525, room: 0 } },
  ]);
  assert.equal(none, null);
});
