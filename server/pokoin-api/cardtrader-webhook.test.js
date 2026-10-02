'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const { createFirestore } = require('./_firestore_fake');

const TARGET = path.join(__dirname, 'cardtrader-webhook.js');

const SALE_ORDER = {
  id: 'ord-1',
  state: 'paid',
  order_items: [{ id: 'item-1', quantity: 1, product: { id: '777' } }],
};

const LISTING_ROW = {
  id: 'L1',
  card_id: '633380',
  quantity_available: 2,
  status: 'active',
  source_listing_id: '777',
  seller_uid: 'seller-1',
};

/**
 * Load the handler with the Pi-only helpers stubbed. DB calls are captured in
 * `calls.read` / `calls.write` keyed by SQL, and writes answer from
 * `onWrite(sql)` (return a row to emulate a successful guarded UPDATE).
 */
function loadWebhook({ onWrite = () => ({ rows: [], rowCount: 0 }), onRead = () => ({ rows: [], rowCount: 0 }) } = {}) {
  const calls = { read: [], write: [] };
  const firestore = createFirestore().firestore;
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === '../server/_marketplace_db') {
      return {
        marketplaceQuery: async (sql, values) => {
          calls.read.push({ sql: String(sql), values });
          return onRead(String(sql), values, calls.read.length);
        },
        marketplaceWriteQuery: async (sql, values) => {
          calls.write.push({ sql: String(sql), values });
          return onWrite(String(sql), values, calls.write.length);
        },
      };
    }
    if (request === '../server/_firebase') {
      return { getFirebaseAdmin: () => createFirestore().admin };
    }
    if (request === './_cardtrader_integration') {
      return {
        decryptIntegrationSharedSecret: async () => 'secret',
        decryptIntegrationToken: async () => 'token',
      };
    }
    if (request === './_cardtrader_seller_listings') {
      return {
        ctSourceListingId: (productId) => String(productId || ''),
        parsePokoinListingId: () => '',
      };
    }
    if (request === './_user_card_collection') {
      return { decrementSellerOwnershipForSale: async () => ({}) };
    }
    if (request === './_cardtrader_inventory_async') {
      return { enqueueCardTraderInventorySync: async () => ({ started: true }) };
    }
    if (request === './_native_sales') {
      return { SALES_COLLECTION: 'marketplace_sales', recordCardTraderSale: async () => ({}) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const webhook = require(TARGET);
    return { webhook, calls, firestore };
  } finally {
    Module._load = originalLoad;
  }
}

/** Default write dispatcher: the guarded decrement returns its row, other writes succeed. */
function decrementSucceeds(sql) {
  if (/update public\.marketplace_user_listings/.test(sql)) {
    return { rows: [{ ...LISTING_ROW, quantity_available: 1, status: 'active' }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

test('a paid CardTrader order decrements via the writer pool and refreshes the price summary on the writer pool', async () => {
  const { webhook, calls } = loadWebhook({
    onRead: (sql) => (/marketplace_user_listings/.test(sql)
      ? { rows: [LISTING_ROW], rowCount: 1 }
      : { rows: [], rowCount: 0 }),
    onWrite: (sql) => decrementSucceeds(sql),
  });
  const results = await webhook._test.handleOrderPayload({
    admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
    firestore: createFirestore().firestore,
    uid: 'seller-1',
    cause: 'order.update',
    order: SALE_ORDER,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].listingId, 'L1');
  const refreshReads = calls.read.filter((call) => /refresh_marketplace_blueprint_price_summary/.test(call.sql));
  const refreshWrites = calls.write.filter((call) => /refresh_marketplace_blueprint_price_summary/.test(call.sql));
  const decrementWrites = calls.write.filter((call) => /update public\.marketplace_user_listings/.test(call.sql));
  assert.equal(decrementWrites.length, 1, 'decrement must be a write-pool statement');
  assert.equal(refreshWrites.length, 1, 'price summary refresh must run on the writer pool');
  assert.equal(refreshReads.length, 0, 'price summary refresh must never run on the read pool');
  assert.equal(refreshWrites[0].values[0], '633380');
});

test('a failed decrement releases the claim so CardTrader redelivery can retry, and never refreshes the price summary', async () => {
  const firestore = createFirestore().firestore;
  let decrementAttempts = 0;
  const { webhook, calls } = loadWebhook({
    onRead: (sql) => (/marketplace_user_listings/.test(sql)
      ? { rows: [LISTING_ROW], rowCount: 1 }
      : { rows: [], rowCount: 0 }),
    onWrite: (sql) => {
      if (/update public\.marketplace_user_listings/.test(sql)) {
        decrementAttempts += 1;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  });
  const results = await webhook._test.handleOrderPayload({
    admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
    firestore,
    uid: 'seller-1',
    cause: 'order.update',
    order: SALE_ORDER,
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].reason, 'decrement_failed');
  assert.equal(calls.write.filter((call) => /refresh_marketplace_blueprint_price_summary/.test(call.sql)).length, 0);
  const claimId = 'seller-1_ord-1_item-1';
  const released = await firestore.collection('cardtrader_webhook_events').doc(claimId).get();
  assert.equal(released.exists, false, 'claim must be released on decrement failure');

  // Redelivery of the same event retries the decrement (claim was released).
  await webhook._test.handleOrderPayload({
    admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
    firestore,
    uid: 'seller-1',
    cause: 'order.update',
    order: SALE_ORDER,
  });
  assert.equal(decrementAttempts, 2, 'released claim must allow a retry');
});

test('a duplicate delivery is skipped by the claim and does not decrement or refresh twice', async () => {
  const firestore = createFirestore().firestore;
  const { webhook, calls } = loadWebhook({
    onRead: (sql) => (/marketplace_user_listings/.test(sql)
      ? { rows: [LISTING_ROW], rowCount: 1 }
      : { rows: [], rowCount: 0 }),
    onWrite: (sql) => decrementSucceeds(sql),
  });
  const run = () => webhook._test.handleOrderPayload({
    admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
    firestore,
    uid: 'seller-1',
    cause: 'order.update',
    order: SALE_ORDER,
  });
  const first = await run();
  assert.equal(first[0].ok, true);
  const second = await run();
  assert.equal(second[0].skipped, true);
  assert.equal(second[0].reason, 'already_processed');
  assert.equal(calls.write.filter((call) => /update public\.marketplace_user_listings/.test(call.sql)).length, 1);
  assert.equal(calls.write.filter((call) => /refresh_marketplace_blueprint_price_summary/.test(call.sql)).length, 1);
});

test('a writer-pool refresh failure is logged, not thrown: the sale result stays ok', async () => {
  const { webhook, calls } = loadWebhook({
    onRead: (sql) => (/marketplace_user_listings/.test(sql)
      ? { rows: [LISTING_ROW], rowCount: 1 }
      : { rows: [], rowCount: 0 }),
    onWrite: (sql) => {
      if (/refresh_marketplace_blueprint_price_summary/.test(sql)) {
        throw new Error('read-only replica rejected the statement');
      }
      return decrementSucceeds(sql);
    },
  });
  const results = await webhook._test.handleOrderPayload({
    admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
    firestore: createFirestore().firestore,
    uid: 'seller-1',
    cause: 'order.update',
    order: SALE_ORDER,
  });
  assert.equal(results[0].ok, true, 'refresh failure must not fail the webhook item');
  assert.equal(calls.write.filter((call) => /refresh_marketplace_blueprint_price_summary/.test(call.sql)).length, 1);
});
