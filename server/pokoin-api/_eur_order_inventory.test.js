'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');
const {
  cancelPendingEurOrder,
  fulfillPaidEurOrder,
  releaseEurReservation,
  reserveEurCheckoutItems,
  sweepEurOrders,
} = require('./_eur_order_inventory');

const MIMIKYU = '3868b36c-e56d-47cf-b1ec-7130c804e335';
const SELLER = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';

/** Postgres marketplace_user_listings + the PKN fulfilment helpers, in memory. */
function fakeDeps(listings = {}) {
  const calls = { ownership: [], cardTraderSync: [], buy: 0, notify: 0, sales: 0 };
  const deps = {
    listings,
    calls,
    normalizedItems: (items) => items
      .map((row) => ({
        listingId: String(row.listingId || ''),
        sellerUid: String(row.sellerUid || ''),
        sellerName: row.sellerName || '',
        quantity: Number(row.quantity || row.qty) || 0,
        unitPricePkn: Number(row.unitPricePkn || row.pricePkn) || 0,
        card: row.card || { id: row.cardId || '', name: row.name || '' },
      }))
      .filter((row) => row.listingId && row.sellerUid && row.quantity > 0 && row.unitPricePkn > 0),
    verifyCardTraderLiveItems: async () => {},
    async verifyAndDecrementListings(items) {
      const taken = [];
      for (const item of items) {
        const row = listings[item.listingId];
        if (!row || row.status !== 'active' || row.qty < item.quantity) {
          for (const entry of taken) listings[entry.listingId].qty += entry.quantity;
          const error = new Error(`Listing ${item.listingId} is no longer available.`);
          error.statusCode = 409;
          throw error;
        }
        if (row.price !== item.unitPricePkn) {
          const error = new Error(`Listing ${item.listingId} price does not match the current ask.`);
          error.statusCode = 409;
          error.code = 'price_mismatch';
          throw error;
        }
        row.qty -= item.quantity;
        if (row.qty <= 0) row.status = 'sold_out';
        taken.push({
          listingId: item.listingId,
          quantity: item.quantity,
          unitPricePkn: row.price,
          cardId: row.cardId,
          sellerUid: item.sellerUid,
          sourceListingId: row.sourceListingId || '',
          source: '',
          remainingQuantity: row.qty,
        });
      }
      return taken;
    },
    async restoreListingQuantities(entries) {
      for (const entry of entries) {
        const row = listings[entry.listingId];
        row.qty += entry.quantity;
        if (row.status === 'sold_out') row.status = 'active';
      }
    },
    async syncSellerOwnershipAfterPhysicalSale({ decremented }) {
      calls.ownership.push(...decremented.map((row) => row.listingId));
      return { ok: true };
    },
    async syncCardTraderAfterPokoinSale({ decremented }) {
      calls.cardTraderSync.push(...decremented.map((row) => row.listingId));
      return { ok: true };
    },
    async buyCardTraderItemsForPaidOrder() {
      calls.buy += 1;
      return { ok: true, skipped: true };
    },
    async sendSellerSaleNotificationsForPaidOrder() {
      calls.notify += 1;
      return { ok: true };
    },
    async recordNativeSales() {
      calls.sales += 1;
      return { ok: true };
    },
  };
  return deps;
}

function mimikyuListing() {
  return { [MIMIKYU]: { qty: 1, price: 20, status: 'active', cardId: '713650', sourceListingId: 'ct:449564446' } };
}

const CART = [{
  listingId: MIMIKYU,
  sellerUid: SELLER,
  sellerName: 'redshakkio',
  quantity: 1,
  unitPricePkn: 20,
  card: { id: '713650', name: 'Mimikyu' },
}];

async function heldOrder(firestore, deps, { paymentStatus = 'pending_stripe', createdAt, expiresAt, sessionId = 'cs_1' } = {}) {
  const reserved = await reserveEurCheckoutItems({ rawItems: CART, deps });
  await firestore.collection('orders').doc('eur_1').set({
    uid: 'buyer1',
    buyerUid: 'buyer1',
    currency: 'EUR',
    paymentMethod: 'stripe',
    items: reserved.items,
    sellerUids: [SELLER],
    paymentStatus,
    fulfillmentStatus: 'pending',
    totalEURCents: 410,
    stripeCheckoutSessionId: sessionId,
    createdAt: createdAt || new Date('2026-09-28T10:00:00Z'),
    inventory: {
      state: 'reserved',
      lines: reserved.lines,
      expiresAt: expiresAt || '2026-09-28T10:31:00Z',
    },
  });
  return reserved;
}

test('opening Stripe takes the listing off Shop (qty 1 → sold_out)', async () => {
  const deps = fakeDeps(mimikyuListing());
  const reserved = await reserveEurCheckoutItems({ rawItems: CART, deps });
  assert.equal(deps.listings[MIMIKYU].qty, 0);
  assert.equal(deps.listings[MIMIKYU].status, 'sold_out');
  assert.equal(reserved.lines.length, 1);
  assert.equal(reserved.items[0].unitPricePkn, 20);
  assert.equal(reserved.items[0].card.id, '713650');
});

test('a second buyer cannot hold a listing that is already held', async () => {
  const deps = fakeDeps(mimikyuListing());
  await reserveEurCheckoutItems({ rawItems: CART, deps });
  await assert.rejects(reserveEurCheckoutItems({ rawItems: CART, deps }), { statusCode: 409 });
});

test('a stale client price never reaches Stripe', async () => {
  const deps = fakeDeps(mimikyuListing());
  await assert.rejects(
    reserveEurCheckoutItems({ rawItems: [{ ...CART[0], unitPricePkn: 1 }], deps }),
    { code: 'price_mismatch' },
  );
});

test('a cart with an unusable row is rejected before any stock moves', async () => {
  const deps = fakeDeps(mimikyuListing());
  await assert.rejects(
    reserveEurCheckoutItems({ rawItems: [...CART, { listingId: '', sellerUid: SELLER, quantity: 1 }], deps }),
    { code: 'invalid_cart' },
  );
  assert.equal(deps.listings[MIMIKYU].qty, 1);
});

test('expiry puts the card back exactly once and closes the order', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps);
  const first = await releaseEurReservation({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(first.outcome, 'released');
  assert.equal(deps.listings[MIMIKYU].qty, 1);
  assert.equal(deps.listings[MIMIKYU].status, 'active');
  const order = firestore.dump('orders/eur_1');
  assert.equal(order.paymentStatus, 'expired');
  assert.equal(order.inventory.state, 'released');
  const second = await releaseEurReservation({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(second.lines, 0);
  assert.equal(deps.listings[MIMIKYU].qty, 1);
});

test('a paid order is never released', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps, { paymentStatus: 'paid' });
  const result = await releaseEurReservation({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(result.outcome, 'not_releasable');
  assert.equal(deps.listings[MIMIKYU].qty, 0);
});

test('paid fulfilment commits the hold and runs every PKN step once', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps, { paymentStatus: 'paid' });
  const first = await fulfillPaidEurOrder({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(first.done, true);
  const order = firestore.dump('orders/eur_1');
  assert.equal(order.inventory.state, 'committed');
  assert.equal(order.fulfillment.state, 'done');
  assert.equal(order.fulfillmentStatus, 'awaiting_shipment');
  assert.deepEqual(deps.calls.ownership, [MIMIKYU]);
  assert.deepEqual(deps.calls.cardTraderSync, [MIMIKYU]);
  assert.equal(deps.calls.notify, 1);
  assert.equal(deps.calls.sales, 1);
  assert.equal(deps.listings[MIMIKYU].qty, 0, 'stock stays sold');

  const again = await fulfillPaidEurOrder({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(again.skipped, 'done');
  assert.deepEqual(deps.calls.ownership, [MIMIKYU]);
});

test('a failed step is retried without repeating finished ones', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps, { paymentStatus: 'paid' });
  let failNotify = true;
  const notify = deps.sendSellerSaleNotificationsForPaidOrder;
  deps.sendSellerSaleNotificationsForPaidOrder = async (args) => {
    if (failNotify) return { ok: false, error: 'smtp down' };
    return notify(args);
  };
  const first = await fulfillPaidEurOrder({ admin, firestore, orderId: 'eur_1', deps });
  assert.deepEqual(first.failures, ['notifications']);
  assert.equal(firestore.dump('orders/eur_1').fulfillment.state, 'partial');
  failNotify = false;
  const second = await fulfillPaidEurOrder({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(second.done, true);
  assert.deepEqual(deps.calls.ownership, [MIMIKYU], 'ownership not decremented twice');
  assert.equal(deps.calls.sales, 1);
});

test('payment landing after the hold was released re-takes stock, or flags a refund', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps);
  await releaseEurReservation({ admin, firestore, orderId: 'eur_1', deps });
  await firestore.collection('orders').doc('eur_1').set({ paymentStatus: 'paid' }, { merge: true });
  const ok = await fulfillPaidEurOrder({ admin, firestore, orderId: 'eur_1', deps });
  assert.equal(ok.done, true);
  assert.equal(deps.listings[MIMIKYU].qty, 0);

  const other = createFirestore();
  const gone = fakeDeps(mimikyuListing());
  await heldOrder(other.firestore, gone);
  await releaseEurReservation({ admin: other.admin, firestore: other.firestore, orderId: 'eur_1', deps: gone });
  gone.listings[MIMIKYU].qty = 0; // sold to someone else meanwhile
  gone.listings[MIMIKYU].status = 'sold_out';
  await other.firestore.collection('orders').doc('eur_1').set({ paymentStatus: 'paid' }, { merge: true });
  const conflict = await fulfillPaidEurOrder({ admin: other.admin, firestore: other.firestore, orderId: 'eur_1', deps: gone });
  assert.equal(conflict.conflict, true);
  assert.equal(other.firestore.dump('orders/eur_1').fulfillmentStatus, 'needs_refund');
});

test('buyer cancel expires the Stripe session first, then releases', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps);
  const expired = [];
  const stripe = { checkout: { sessions: { expire: async (id) => { expired.push(id); } } } };
  const result = await cancelPendingEurOrder({ admin, firestore, stripe, orderId: 'eur_1', uid: 'buyer1', deps });
  assert.deepEqual(expired, ['cs_1']);
  assert.equal(result.outcome, 'released');
  assert.equal(firestore.dump('orders/eur_1').paymentStatus, 'cancelled');
  assert.equal(deps.listings[MIMIKYU].qty, 1);
});

test('cancel on a session Stripe already charged runs the paid path instead', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps);
  const paidSessions = [];
  const stripe = {
    checkout: {
      sessions: {
        expire: async () => { throw new Error('session is complete'); },
        retrieve: async () => ({ id: 'cs_1', status: 'complete', payment_status: 'paid' }),
      },
    },
  };
  await assert.rejects(
    cancelPendingEurOrder({
      admin, firestore, stripe, orderId: 'eur_1', uid: 'buyer1', deps, onPaid: async (s) => paidSessions.push(s.id),
    }),
    { code: 'already_paid' },
  );
  assert.deepEqual(paidSessions, ['cs_1']);
  assert.equal(deps.listings[MIMIKYU].qty, 0, 'stock stays with the paying buyer');
});

test('another buyer cannot cancel the order', async () => {
  const { admin, firestore } = createFirestore();
  const deps = fakeDeps(mimikyuListing());
  await heldOrder(firestore, deps);
  await assert.rejects(
    cancelPendingEurOrder({ admin, firestore, stripe: {}, orderId: 'eur_1', uid: 'intruder', deps }),
    { statusCode: 403 },
  );
});

test('sweep: stale hold released, missed payment recovered, fresh hold left alone', async () => {
  const now = new Date('2026-09-28T11:00:00Z').getTime();
  const { admin, firestore } = createFirestore({
    orders: {
      eur_stale: {
        paymentStatus: 'pending_stripe',
        stripeCheckoutSessionId: 'cs_stale',
        createdAt: new Date('2026-09-28T10:00:00Z'),
        inventory: { state: 'reserved', expiresAt: '2026-09-28T10:31:00Z', lines: [{ listingId: MIMIKYU, quantity: 1 }] },
      },
      eur_paid: {
        paymentStatus: 'pending_stripe',
        stripeCheckoutSessionId: 'cs_paid',
        createdAt: new Date('2026-09-28T10:00:00Z'),
        inventory: { state: 'reserved', expiresAt: '2026-09-28T10:31:00Z', lines: [] },
      },
      eur_fresh: {
        paymentStatus: 'pending_stripe',
        stripeCheckoutSessionId: 'cs_fresh',
        createdAt: new Date('2026-09-28T10:55:00Z'),
        inventory: { state: 'reserved', expiresAt: '2026-09-28T11:26:00Z', lines: [] },
      },
      eur_ghost: {
        paymentStatus: 'pending_stripe',
        createdAt: new Date('2026-09-27T20:00:00Z'),
      },
      eur_legacy: {
        paymentStatus: 'pending_stripe',
        stripeCheckoutSessionId: 'cs_legacy',
        createdAt: new Date('2026-09-28T08:48:00Z'),
      },
    },
  });
  const deps = fakeDeps({ [MIMIKYU]: { qty: 0, price: 20, status: 'sold_out', cardId: '713650' } });
  const sessions = {
    cs_stale: { id: 'cs_stale', status: 'open', expires_at: Math.floor(new Date('2026-09-28T10:31:00Z').getTime() / 1000) },
    cs_paid: { id: 'cs_paid', status: 'complete', payment_status: 'paid' },
    cs_fresh: { id: 'cs_fresh', status: 'open', expires_at: Math.floor(new Date('2026-09-28T11:26:00Z').getTime() / 1000) },
    // Pre-hold session: Stripe's default 24h expiry, nothing reserved.
    cs_legacy: { id: 'cs_legacy', status: 'open', expires_at: Math.floor(new Date('2026-09-29T08:48:00Z').getTime() / 1000) },
  };
  const expired = [];
  const recovered = [];
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => sessions[id],
        expire: async (id) => { expired.push(id); },
      },
    },
  };
  const result = await sweepEurOrders({
    admin, firestore, stripe, deps, now, log: { log() {} }, onPaid: async (s) => recovered.push(s.id),
  });
  const actions = Object.fromEntries(result.results.map((row) => [row.orderId, row.action]));
  assert.equal(actions.eur_stale, 'release_expired');
  assert.equal(actions.eur_paid, 'recover_paid');
  assert.equal(actions.eur_ghost, 'release_no_session');
  assert.equal(actions.eur_fresh, undefined);
  assert.equal(actions.eur_legacy, 'release_expired');
  assert.deepEqual(expired.sort(), ['cs_legacy', 'cs_stale']);
  assert.deepEqual(recovered, ['cs_paid']);
  assert.equal(deps.listings[MIMIKYU].qty, 1);
  assert.equal(firestore.dump('orders/eur_ghost').paymentStatus, 'expired');
  assert.equal(firestore.dump('orders/eur_fresh').paymentStatus, 'pending_stripe');
});

test('sweep dry run changes nothing', async () => {
  const now = new Date('2026-09-28T11:00:00Z').getTime();
  const { admin, firestore } = createFirestore({
    orders: { eur_ghost: { paymentStatus: 'pending_stripe', createdAt: new Date('2026-09-27T20:00:00Z') } },
  });
  const result = await sweepEurOrders({
    admin, firestore, stripe: {}, deps: fakeDeps(), now, dryRun: true, log: { log() {} },
  });
  assert.equal(result.results[0].action, 'release_no_session');
  assert.equal(firestore.dump('orders/eur_ghost').paymentStatus, 'pending_stripe');
});
