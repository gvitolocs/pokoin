'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');
const { refundSellerShare } = require('./_order_refund');

const SELLER = 'seller1';
const OTHER = 'seller2';

function eurOrder(extra = {}) {
  return {
    uid: 'buyer1',
    buyerUid: 'buyer1',
    currency: 'EUR',
    paymentMethod: 'stripe',
    paymentStatus: 'paid',
    stripePaymentIntentId: 'pi_1',
    sellerUids: [SELLER, OTHER],
    items: [
      { listingId: 'l1', sellerUid: SELLER, quantity: 1, unitPricePkn: 200, unitPriceEURCents: 100, card: { id: 'c1' } },
      { listingId: 'l2', sellerUid: OTHER, quantity: 1, unitPricePkn: 400, unitPriceEURCents: 200, card: { id: 'c2' } },
    ],
    shipments: [
      { sellerId: SELLER, itemsSubtotalCents: 100, shippingAmountEURCents: 310, sellerTransferCents: 407 },
      { sellerId: OTHER, itemsSubtotalCents: 200, shippingAmountEURCents: 310, sellerTransferCents: 504 },
    ],
    ...extra,
  };
}

function pknOrder(extra = {}) {
  return {
    uid: 'buyer1',
    buyerUid: 'buyer1',
    paymentStatus: 'escrow',
    sellerUids: [SELLER],
    items: [{ listingId: 'l1', sellerUid: SELLER, quantity: 2, unitPricePkn: 500, totalPricePkn: 1000, card: { id: 'c1' } }],
    ...extra,
  };
}

function fakeStripe() {
  const calls = { refunds: [], reversals: [] };
  return {
    calls,
    refunds: {
      create: async (body, options) => {
        calls.refunds.push({ body, options });
        return { id: `re_${calls.refunds.length}` };
      },
    },
    transfers: {
      retrieve: async (id) => ({ id, amount: 407, amount_reversed: 0 }),
      list: async () => ({ data: [] }),
      createReversal: async (id, body) => {
        calls.reversals.push({ id, body });
        return { id: `trr_${calls.reversals.length}` };
      },
    },
  };
}

test('EUR partial refund before payout: Stripe refund + smaller seller Transfer', async () => {
  const { admin, firestore } = createFirestore({ orders: { eur_1: eurOrder() } });
  const stripe = fakeStripe();
  const result = await refundSellerShare({
    admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 150, reason: 'corner ding', clientToken: 'tok_abcdef12',
  });
  assert.equal(result.refund.status, 'succeeded');
  assert.equal(result.refundable, 260);
  assert.equal(stripe.calls.refunds[0].body.amount, 150);
  assert.equal(stripe.calls.refunds[0].body.payment_intent, 'pi_1');
  assert.equal(stripe.calls.reversals.length, 0);
  const order = firestore.dump('orders/eur_1');
  assert.equal(order.shipments[0].refundedCents, 150);
  assert.equal(order.shipments[1].refundedCents, undefined, 'other seller untouched');
  assert.equal(order.refundsBySeller[SELLER], 150);
});

test('EUR refund after payout reverses the seller Transfer', async () => {
  const { admin, firestore } = createFirestore({
    orders: { eur_1: eurOrder({ paymentStatus: 'released', transferIds: ['tr_9'], transfersBySeller: { [SELLER]: 'tr_9' } }) },
  });
  const stripe = fakeStripe();
  await refundSellerShare({
    admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 100, clientToken: 'tok_abcdef13',
  });
  assert.deepEqual(stripe.calls.reversals.map((row) => [row.id, row.body.amount]), [['tr_9', 100]]);
  const refund = firestore.dump('orders/eur_1').refunds[0];
  assert.equal(refund.transferReversalId, 'trr_1');
});

test('a refund can never exceed what is left of the seller share', async () => {
  const { admin, firestore } = createFirestore({ orders: { eur_1: eurOrder() } });
  const stripe = fakeStripe();
  await refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 400, clientToken: 'tok_one_1234' });
  await assert.rejects(
    refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 11, clientToken: 'tok_two_1234' }),
    { code: 'refund_too_large' },
  );
  assert.equal(stripe.calls.refunds.length, 1);
});

test('double click with the same token refunds once', async () => {
  const { admin, firestore } = createFirestore({ orders: { eur_1: eurOrder() } });
  const stripe = fakeStripe();
  await refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 50, clientToken: 'tok_same_123' });
  const again = await refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 50, clientToken: 'tok_same_123' });
  assert.equal(again.duplicate, true);
  assert.equal(stripe.calls.refunds.length, 1);
});

test('a Stripe failure frees the reserved cap again', async () => {
  const { admin, firestore } = createFirestore({ orders: { eur_1: eurOrder() } });
  const stripe = fakeStripe();
  stripe.refunds.create = async () => { throw new Error('card network down'); };
  await assert.rejects(
    refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 410, clientToken: 'tok_fail_123' }),
    { code: 'stripe_refund_failed' },
  );
  assert.equal(firestore.dump('orders/eur_1').refunds[0].status, 'failed');
  const ok = fakeStripe();
  const result = await refundSellerShare({ admin, firestore, stripe: ok, orderId: 'eur_1', sellerUid: SELLER, amount: 410, clientToken: 'tok_retry_12' });
  assert.equal(result.refundable, 0);
});

test('unpaid, foreign and zero refunds are refused', async () => {
  const { admin, firestore } = createFirestore({
    orders: { pending: eurOrder({ paymentStatus: 'pending_stripe' }), eur_1: eurOrder() },
  });
  const stripe = fakeStripe();
  await assert.rejects(
    refundSellerShare({ admin, firestore, stripe, orderId: 'pending', sellerUid: SELLER, amount: 10, clientToken: 'tok_pend_123' }),
    { code: 'order_not_paid' },
  );
  await assert.rejects(
    refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: 'stranger', amount: 10, clientToken: 'tok_strg_123' }),
    { code: 'not_seller' },
  );
  await assert.rejects(
    refundSellerShare({ admin, firestore, stripe, orderId: 'eur_1', sellerUid: SELLER, amount: 0, clientToken: 'tok_zero_123' }),
    { code: 'invalid_amount' },
  );
});

test('PKN escrow refund credits the buyer and escrow later pays the seller less', async () => {
  const { admin, firestore } = createFirestore({ orders: { o1: pknOrder() }, balances: { buyer1: { availablePkn: 0 } } });
  const result = await refundSellerShare({
    admin, firestore, stripe: null, orderId: 'o1', sellerUid: SELLER, amount: 300, clientToken: 'tok_pkn_1234',
  });
  assert.equal(result.refund.status, 'succeeded');
  assert.equal(firestore.dump('balances/buyer1').availablePkn, 300);
  assert.equal(firestore.dump('orders/o1').refundsBySeller[SELLER], 300);
  assert.equal(firestore.dump(`balances/${SELLER}`), undefined, 'escrow: seller balance untouched');
});

test('PKN refund after release comes out of the seller balance', async () => {
  const { admin, firestore } = createFirestore({
    orders: { o1: pknOrder({ paymentStatus: 'released' }) },
    balances: { buyer1: { availablePkn: 0 }, [SELLER]: { availablePkn: 250 } },
  });
  await assert.rejects(
    refundSellerShare({ admin, firestore, orderId: 'o1', sellerUid: SELLER, amount: 300, clientToken: 'tok_low_1234' }),
    { code: 'seller_balance_low' },
  );
  await refundSellerShare({ admin, firestore, orderId: 'o1', sellerUid: SELLER, amount: 200, clientToken: 'tok_ok_12345' });
  assert.equal(firestore.dump(`balances/${SELLER}`).availablePkn, 50);
  assert.equal(firestore.dump('balances/buyer1').availablePkn, 200);
  const ledger = firestore.all('ledger_entries').map((row) => [row.uid, row.type, row.amountPkn]).sort();
  assert.deepEqual(ledger, [['buyer1', 'marketplace_order_refund', 200], [SELLER, 'marketplace_sale_refund', -200]]);
});

test('refunding the whole seller share voids that seller sold rows', async () => {
  const { admin, firestore } = createFirestore({
    orders: { o1: pknOrder() },
    marketplace_sales: {
      o1__l1: { orderId: 'o1', sellerUid: SELLER, cardId: 'c1', voided: false },
      o1__x: { orderId: 'o1', sellerUid: OTHER, cardId: 'c9', voided: false },
    },
  });
  await refundSellerShare({ admin, firestore, orderId: 'o1', sellerUid: SELLER, amount: 1000, clientToken: 'tok_full_123' });
  assert.equal(firestore.dump('marketplace_sales/o1__l1').voided, true);
  assert.equal(firestore.dump('marketplace_sales/o1__x').voided, false);
});
