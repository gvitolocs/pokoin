'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMarketplaceOrderPaid, releaseSellerTransfers } = require('./_marketplace_order_stripe');

function makeAdmin(store) {
  const admin = {
    firestore() {
      return {
        FieldValue: { serverTimestamp: () => 'TS' },
        collection() {
          return {
            doc() {
              return {
                async get() { return { exists: true, data: () => store }; },
                async set(payload) { Object.assign(store, payload); },
              };
            },
          };
        },
      };
    },
  };
  admin.firestore.FieldValue = { serverTimestamp: () => 'TS' };
  return admin;
}

test('paid webhook is idempotent on duplicate session', async () => {
  const store = {
    buyerUid: 'buyer1',
    totalEURCents: 4100,
    paymentStatus: 'pending_stripe',
    shipments: [],
  };
  const admin = makeAdmin(store);
  const session = {
    id: 'cs_1',
    amount_total: 4100,
    payment_intent: 'pi_1',
    metadata: { kind: 'marketplace_order_eur', pokoinOrderId: 'eur_1', pokoinUid: 'buyer1' },
  };
  const first = await handleMarketplaceOrderPaid({ admin, stripe: {}, session });
  assert.equal(first.duplicate, false);
  assert.equal(store.paymentStatus, 'paid');
  const second = await handleMarketplaceOrderPaid({ admin, stripe: {}, session });
  assert.equal(second.duplicate, true);
});

test('releaseSellerTransfers is idempotent', async () => {
  const store = {
    paymentStatus: 'paid',
    transfersReleased: false,
    shipments: [
      { sellerId: 's1', stripeConnectAccountId: 'acct_1', sellerTransferCents: 1000 },
    ],
  };
  const transfers = [];
  const admin = makeAdmin(store);
  const stripe = {
    transfers: {
      create: async (body) => {
        transfers.push(body);
        return { id: `tr_${transfers.length}` };
      },
    },
  };
  const first = await releaseSellerTransfers({ admin, stripe, orderId: 'eur_1' });
  assert.equal(first.duplicate, false);
  assert.equal(transfers.length, 1);
  const second = await releaseSellerTransfers({ admin, stripe, orderId: 'eur_1' });
  assert.equal(second.duplicate, true);
  assert.equal(transfers.length, 1);
});

test('releaseSellerTransfers creates one Transfer per seller shipment', async () => {
  const store = {
    paymentStatus: 'paid',
    transfersReleased: false,
    stripePaymentIntentId: 'pi_1',
    stripeChargeId: 'ch_1',
    shipments: [
      { sellerId: 's1', stripeConnectAccountId: 'acct_1', sellerTransferCents: 1000 },
      { sellerId: 's2', stripeConnectAccountId: 'acct_2', sellerTransferCents: 2500 },
    ],
  };
  const transfers = [];
  const admin = makeAdmin(store);
  const stripe = {
    transfers: {
      create: async (body) => {
        transfers.push(body);
        return { id: `tr_${transfers.length}` };
      },
    },
  };
  const result = await releaseSellerTransfers({ admin, stripe, orderId: 'eur_multi' });
  assert.equal(result.duplicate, false);
  assert.equal(transfers.length, 2);
  assert.equal(transfers[0].destination, 'acct_1');
  assert.equal(transfers[0].amount, 1000);
  assert.equal(transfers[0].source_transaction, 'ch_1');
  assert.equal(transfers[0].transfer_group, 'eur_multi');
  assert.equal(transfers[1].destination, 'acct_2');
  assert.equal(transfers[1].amount, 2500);
});

test('amount mismatch fails closed', async () => {
  const store = {
    buyerUid: 'buyer1',
    totalEURCents: 4100,
    paymentStatus: 'pending_stripe',
  };
  await assert.rejects(
    () => handleMarketplaceOrderPaid({
      admin: makeAdmin(store),
      stripe: {},
      session: {
        id: 'cs_2',
        amount_total: 1,
        metadata: { kind: 'marketplace_order_eur', pokoinOrderId: 'eur_2', pokoinUid: 'buyer1' },
      },
    }),
    /does not match/,
  );
});
