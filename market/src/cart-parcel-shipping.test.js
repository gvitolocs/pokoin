import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryCountryFrom, profileCountryFrom } from './cart-rails-core.js';
import { liveShippingTotals } from './live-shipping.js';

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
      { id: 'untracked', label: 'Untracked letter', amountCents: 131, tracked: false, serviceName: 'Poste Italiane' },
      { id: 'packlink:1', label: 'Postamail Internazionale', amountCents: 900, tracked: true },
    ]],
    ['b', [
      { id: 'untracked', label: 'Untracked letter', amountCents: 310, tracked: false, serviceName: 'dao' },
      { id: 'packlink:2', label: 'GLS', amountCents: 700, tracked: true },
    ]],
  ]);
  const base = { liveByKey, ticked: [redshakkio, givi], country: 'DK', activeService: '', allowUntracked: true };

  const cheapest = liveShippingTotals(base);
  assert.equal(cheapest.count, 2);
  assert.deepEqual(cheapest.parcels.map((p) => [p.from, p.estimate.serviceId]), [['IT', 'untracked'], ['DK', 'untracked']]);
  assert.equal(cheapest.cents, 131 + 310);
  assert.deepEqual(cheapest.parcels[1].options.map((o) => o.id), ['untracked', 'packlink:2']);

  // A pick on one parcel does not move the other one.
  const picked = liveShippingTotals({ ...base, parcelPicks: { a: 'packlink:1' } });
  assert.deepEqual(picked.parcels.map((p) => p.estimate.serviceId), ['packlink:1', 'untracked']);
  assert.equal(picked.cents, 900 + 310);

  // An order-wide service only one lane has does not leak onto the other parcel.
  const wide = liveShippingTotals({ ...base, activeService: 'packlink:1' });
  assert.deepEqual(wide.parcels.map((p) => p.estimate.serviceId), ['packlink:1', 'untracked']);
  assert.equal(wide.cents, 900 + 310);
});

test('seeded rates (before the live answer) are per parcel too', () => {
  const seeded = liveShippingTotals({
    liveByKey: new Map(), ticked: [redshakkio, givi], country: 'DK', activeService: '', allowUntracked: true,
  });
  assert.equal(seeded.count, 2);
  assert.deepEqual(seeded.parcels.map((p) => p.from), ['IT', 'DK']);
  assert.equal(seeded.cents, seeded.parcels.reduce((sum, p) => sum + (p.estimate?.amountCents || 0), 0));
});
