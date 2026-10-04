'use strict';
// setDefaults fans batch-default changes out to every active row. The row
// update binds the changed fields at $1..$N and the batch id last — the 2026-10-04
// production 500 (42P18 "could not determine data type of parameter $1") had the
// field placeholders start at $2 while the batch id also took the last slot.
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { createStore } = require('./_scan_store');

// _scan_bus.js ships in the Pi release baseline, not this repo: stub the lazy
// require from _scan_store so notifyBatch is a no-op under test.
const storePath = require.resolve('./_scan_store');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './_scan_bus' && parent && parent.filename === storePath) {
    return { notifyBatch() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const SELLER = '22222222-2222-4222-8222-222222222222';

function batchRow(overrides = {}) {
  return {
    id: BATCH_ID,
    seller_uid: SELLER,
    status: 'open',
    defaults: { language: 'EN', condition: 'NM', location: '' },
    defaults_version: 3,
    defaults_history: [],
    item_seq: 6,
    item_position: 2,
    ...overrides,
  };
}

function fakePool(batch) {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text: String(text), values: values || [] });
      if (/for update/.test(text)) return { rows: [batch] };
      if (/returning item_seq, item_position/.test(text)) return { rows: [{ item_seq: 7, item_position: 2 }] };
      if (/update public\.scan_batches/.test(text)) return { rows: [{ ...batch }] };
      if (/update public\.scan_items/.test(text)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  return { queries, connect: async () => client };
}

test('one changed row field binds at $1 with the batch id at $2', async () => {
  const pool = fakePool(batchRow());
  const store = createStore({ pool });
  await store.setDefaults({ sellerUid: SELLER, batchId: BATCH_ID, defaults: { location: 'megaevoluzione' } });
  const update = pool.queries.find((q) => /update public\.scan_items/.test(q.text));
  assert.ok(update, 'the row update ran');
  assert.match(update.text, /set location = \$1,/);
  assert.match(update.text, /where batch_id = \$2 and status = 'active'/);
  assert.deepEqual(update.values, ['megaevoluzione', BATCH_ID]);
});

test('two changed row fields bind in order and the batch id stays last', async () => {
  const pool = fakePool(batchRow());
  const store = createStore({ pool });
  await store.setDefaults({ sellerUid: SELLER, batchId: BATCH_ID, defaults: { language: 'JP', location: 'box 2' } });
  const update = pool.queries.find((q) => /update public\.scan_items/.test(q.text));
  assert.ok(update, 'the row update ran');
  assert.match(update.text, /set language = \$1,/);
  assert.match(update.text, /location = \$2,/);
  assert.match(update.text, /where batch_id = \$3 and status = 'active'/);
  assert.deepEqual(update.values, ['JP', 'box 2', BATCH_ID]);
});

test('a defaults change with no row fields never touches scan_items', async () => {
  const pool = fakePool(batchRow());
  const store = createStore({ pool });
  await store.setDefaults({ sellerUid: SELLER, batchId: BATCH_ID, defaults: { stack: 2 } });
  assert.equal(
    pool.queries.some((q) => /update public\.scan_items/.test(q.text)),
    false,
    'stack lives on the batch, not on rows',
  );
});
