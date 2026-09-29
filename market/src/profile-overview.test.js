import assert from 'node:assert/strict';
import test from 'node:test';
import { orderActivity, orderTitle, sellerSetupSteps, timeAgo } from './profile-overview.js';

test('seller setup counts only finished steps and keeps loading apart', () => {
  const loading = sellerSetupSteps();
  assert.equal(loading.done, 0);
  assert.equal(loading.total, 3);
  assert.ok(loading.steps.every((step) => step.loading));

  const partial = sellerSetupSteps({
    shipFromCountry: 'DK',
    stripe: { stripeConnectStatus: 'pending', ready: false },
    cardTrader: { connected: true },
  });
  assert.equal(partial.done, 2);
  const stripe = partial.steps.find((step) => step.key === 'stripe');
  assert.equal(stripe.done, false);
  assert.equal(stripe.started, true);

  const empty = sellerSetupSteps({ shipFromCountry: '', stripe: {}, cardTrader: { connected: false } });
  assert.equal(empty.done, 0);
  assert.ok(empty.steps.every((step) => !step.loading));
  assert.equal(empty.steps.find((step) => step.key === 'stripe').started, false);
});

test('order title names the first card and counts the rest', () => {
  assert.equal(orderTitle({ items: [{ card: { name: 'Pikachu' } }, { cardName: 'Eevee' }] }), 'Pikachu +1');
  assert.equal(orderTitle({ items: [{ cardName: 'Umbreon VMAX' }] }), 'Umbreon VMAX');
  assert.equal(orderTitle({}), 'Order');
});

test('order activity: seller sees paid orders only, counts to-ship and 30-day sales', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const day = 24 * 60 * 60 * 1000;
  const rows = [
    { id: 'b1', uid: 'me', paymentStatus: 'pending_stripe', currency: 'EUR', totalEURCents: 500, createdAt: new Date(now - day).toISOString() },
    { id: 's1', uid: 'x', sellerUids: ['me'], paymentStatus: 'paid', fulfillmentStatus: 'awaiting_shipment', currency: 'EUR', totalEURCents: 1250, createdAt: new Date(now - 2 * 3600000).toISOString() },
    { id: 's2', uid: 'y', sellerUids: ['me'], paymentStatus: 'released', fulfillmentStatus: 'delivered', totalPkn: 300, createdAt: new Date(now - 40 * day).toISOString() },
    { id: 's3', uid: 'z', sellerUids: ['me'], paymentStatus: 'pending_stripe', currency: 'EUR', totalEURCents: 999, createdAt: new Date(now).toISOString() },
    { id: 's4', uid: 'w', sellerUids: ['me'], paymentStatus: 'escrow', fulfillmentStatus: 'shipped', totalPkn: 42, createdAt: new Date(now - 3 * day).toISOString() },
    { id: 'other', uid: 'q', sellerUids: ['q2'], paymentStatus: 'paid' },
  ];
  const out = orderActivity([...rows, rows[1]], 'me', { now });
  assert.deepEqual(out.recent.map((row) => row.id), ['s1', 'b1', 's4', 's2']);
  assert.equal(out.recent[0].role, 'sold');
  assert.equal(out.recent[1].role, 'bought');
  assert.equal(out.total, 4);
  assert.equal(out.toShip, 1);
  assert.equal(out.sales30d, 2);
  assert.equal(out.salesEurCents30d, 1250);
  assert.equal(out.salesPkn30d, 42);
});

test('time ago stays short', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  assert.equal(timeAgo(0, now), '');
  assert.equal(timeAgo(now - 20000, now), 'Just now');
  assert.equal(timeAgo(now - 5 * 60000, now), '5m ago');
  assert.equal(timeAgo(now - 2 * 3600000, now), '2h ago');
  assert.equal(timeAgo(now - 30 * 3600000, now), 'Yesterday');
  assert.equal(timeAgo(now - 3 * 86400000, now), '3d ago');
  assert.equal(timeAgo(Date.UTC(2026, 8, 2, 12), now), 'Sep 2');
});
