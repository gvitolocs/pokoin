import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryCountryFrom, profileCountryFrom } from './cart-rails-core.js';
import { liveShippingServices, liveShippingTotals } from './live-shipping.js';

const redshakkio = { key: 'a', sellerUsername: 'redshakkio', sellerCountry: 'IT', selectedCount: 1 };
const givi = { key: 'b', sellerUsername: 'givi', sellerCountry: 'DK', selectedCount: 1 };

test('deliver-to: profile country first, then the saved address, then the browser', () => {
  assert.deepEqual(deliveryCountryFrom('IT', 'DK'), { country: 'DK', saved: true });
  assert.deepEqual(deliveryCountryFrom('IT', ''), { country: 'IT', saved: true });
  assert.deepEqual(deliveryCountryFrom('', 'XX'), deliveryCountryFrom('', ''));
  assert.equal(profileCountryFrom({ shipFromCountry: 'dk' }), 'DK');
  assert.equal(profileCountryFrom(null), '');
});

test('two sellers ship as two parcels, each on its own lane and service', () => {
  const liveByKey = new Map([
    ['a', [
      { id: 'untracked', label: 'Untracked letter', amountCents: 131, tracked: false, carrier: 'Poste Italiane' },
      { id: 'tracked', label: 'Tracked', amountCents: 1684, tracked: true, carrier: 'UPS' },
    ]],
    ['b', [
      { id: 'untracked', label: 'Untracked letter', amountCents: 310, tracked: false, carrier: 'dao' },
      { id: 'tracked', label: 'Tracked', amountCents: 700, tracked: true, carrier: 'GLS' },
    ]],
  ]);
  const base = { liveByKey, ticked: [redshakkio, givi], country: 'DK', activeService: '', allowUntracked: true };

  const cheapest = liveShippingTotals(base);
  assert.equal(cheapest.count, 2);
  assert.deepEqual(cheapest.parcels.map((p) => [p.from, p.estimate.serviceId]), [['IT', 'untracked'], ['DK', 'untracked']]);
  assert.equal(cheapest.cents, 131 + 310);
  assert.deepEqual(cheapest.parcels[1].options.map((o) => o.label), ['Untracked letter (dao)', 'Tracked (GLS)']);

  // A pick on one parcel does not move the other one.
  const picked = liveShippingTotals({ ...base, parcelPicks: { a: 'tracked' } });
  assert.deepEqual(picked.parcels.map((p) => p.estimate.serviceId), ['tracked', 'untracked']);
  assert.equal(picked.cents, 1684 + 310);
});

test('live Packlink rates are not offered: checkout cannot book them', () => {
  const liveByKey = new Map([
    ['a', [
      { id: 'untracked', label: 'Untracked letter', amountCents: 131, tracked: false },
      { id: 'packlink:1', label: 'GLS', amountCents: 90, tracked: true },
    ]],
    // A lane Packlink alone answers falls back to the seeded letter rates.
    ['b', [{ id: 'packlink-2', label: 'GLS', amountCents: 700, tracked: true }]],
  ]);
  const base = { liveByKey, ticked: [redshakkio, givi], country: 'DK', activeService: '', allowUntracked: true };
  const totals = liveShippingTotals({ ...base, parcelPicks: { a: 'packlink:1' } });
  for (const parcel of totals.parcels) {
    assert.ok(parcel.options.length);
    assert.ok(parcel.options.every((o) => o.id === 'tracked' || o.id === 'untracked'), parcel.options.map((o) => o.id).join());
  }
  assert.equal(totals.parcels[0].estimate.serviceId, 'untracked');
  assert.equal(totals.parcels[0].estimate.fallback, true);
  const services = liveShippingServices({ liveByKey, seedServices: [], ticked: base.ticked, allowUntracked: true });
  assert.deepEqual(services.map((row) => row.id), ['untracked']);
});

test('seeded rates (before the live answer) are per parcel too', () => {
  const seeded = liveShippingTotals({
    liveByKey: new Map(), ticked: [redshakkio, givi], country: 'DK', activeService: '', allowUntracked: true,
  });
  assert.equal(seeded.count, 2);
  assert.deepEqual(seeded.parcels.map((p) => p.from), ['IT', 'DK']);
  assert.equal(seeded.cents, seeded.parcels.reduce((sum, p) => sum + (p.estimate?.amountCents || 0), 0));
});
