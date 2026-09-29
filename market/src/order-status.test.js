import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canResumePayment,
  filterOrdersByArchive,
  formatOrderMoney,
  holdMinutesLeft,
  isArchivedOrder,
  newRefundToken,
  orderStatus,
  refundAmountFromInput,
  refundInputFromAmount,
  visibleOrders,
} from './order-status.js';

const NOW = new Date('2026-09-28T10:10:00Z').getTime();

test('unpaid EUR orders say not charged, never sold', () => {
  assert.equal(orderStatus({ paymentStatus: 'pending_stripe' }).label, 'Awaiting payment');
  assert.equal(orderStatus({ paymentStatus: 'expired' }).label, 'Expired · not charged');
  assert.equal(orderStatus({ paymentStatus: 'cancelled' }).label, 'Cancelled · not charged');
  assert.equal(orderStatus({ paymentStatus: 'paid' }).tone, 'ok');
  assert.equal(orderStatus({ paymentStatus: 'paid', fulfillmentStatus: 'needs_refund' }).tone, 'warn');
});

test('archived hides expired cancelled failed and refunded orders', () => {
  assert.equal(isArchivedOrder({ paymentStatus: 'expired' }), true);
  assert.equal(isArchivedOrder({ paymentStatus: 'cancelled' }), true);
  assert.equal(isArchivedOrder({ paymentStatus: 'failed' }), true);
  assert.equal(isArchivedOrder({ paymentStatus: 'refunded' }), true);
  assert.equal(isArchivedOrder({ paymentStatus: 'escrow' }), false);
  assert.equal(isArchivedOrder({ paymentStatus: 'paid' }), false);
  assert.equal(isArchivedOrder({ paymentStatus: 'pending_stripe' }), false);
  assert.equal(isArchivedOrder({ paymentStatus: 'paid', fulfillmentStatus: 'cancelled_not_shipped' }), true);
  const rows = [
    { id: 'live', paymentStatus: 'escrow' },
    { id: 'dead', paymentStatus: 'expired' },
    { id: 'pay', paymentStatus: 'pending_stripe' },
  ];
  assert.deepEqual(filterOrdersByArchive(rows, false).map((r) => r.id), ['live', 'pay']);
  assert.deepEqual(filterOrdersByArchive(rows, true).map((r) => r.id), ['dead']);
});

test('seller never sees an abandoned Stripe checkout as an order', () => {
  const rows = [
    { id: 'a', uid: 'buyer', sellerUids: ['seller'], paymentStatus: 'pending_stripe' },
    { id: 'b', uid: 'buyer', sellerUids: ['seller'], paymentStatus: 'expired' },
    { id: 'c', uid: 'buyer', sellerUids: ['seller'], paymentStatus: 'paid' },
  ];
  assert.deepEqual(visibleOrders(rows, 'seller').map((row) => row.id), ['c']);
  assert.deepEqual(visibleOrders(rows, 'buyer').map((row) => row.id), ['a', 'b', 'c']);
});

test('resume link only while the 30-minute hold is live', () => {
  const row = { paymentStatus: 'pending_stripe', stripeCheckoutUrl: 'https://checkout.stripe.com/x', inventory: { expiresAt: '2026-09-28T10:31:00Z' } };
  assert.equal(canResumePayment(row, NOW), true);
  assert.equal(holdMinutesLeft(row, NOW), 21);
  assert.equal(canResumePayment(row, new Date('2026-09-28T10:32:00Z').getTime()), false);
  assert.equal(canResumePayment({ ...row, paymentStatus: 'paid' }, NOW), false);
});

test('refund input converts to the order unit', () => {
  assert.equal(refundAmountFromInput('1.50', 'EUR'), 150);
  assert.equal(refundAmountFromInput('0,75', 'EUR'), 75);
  assert.equal(refundAmountFromInput('300', 'PKN'), 300);
  assert.ok(Number.isNaN(refundAmountFromInput('3.5', 'PKN')));
  assert.ok(Number.isNaN(refundAmountFromInput('abc', 'EUR')));
  assert.equal(refundInputFromAmount(410, 'EUR'), '4.10');
  assert.equal(formatOrderMoney(410, 'EUR'), '€4.10');
  assert.equal(formatOrderMoney(20, 'PKN'), '20 PKN');
  assert.match(newRefundToken(), /^rf[0-9a-f]{24}$/);
});

test('vercel and vite serve /sales (Sold history) as the market SPA', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const vercel = JSON.parse(fs.readFileSync(path.join(root, '../../vercel.json'), 'utf8'));
  const viteSrc = fs.readFileSync(path.join(root, '../vite.config.js'), 'utf8');
  const rewrites = vercel.rewrites || [];
  for (const source of ['/sales', '/sales/', '/orders']) {
    assert.ok(rewrites.some((r) => r.source === source && r.destination === '/market/index.html'), source);
  }
  assert.match(viteSrc, /url === '\/sales'/);
});
