'use strict';
// A new batch starts where the seller left off: startSession copies ONLY the
// location and cards-per-stack of the most recent batch that had a location.
// stack/startPosition stay at 1 — the desk advances them from live stock
// (nextFreeSlot in ScanDesk.jsx), so a stale stack 104 must not be inherited.
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { createStore } = require('./_scan_store');
const { DEFAULT_BATCH_DEFAULTS } = require('./_scan_connect');

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
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const SELLER = '22222222-2222-4222-8222-222222222222';

function sessionRow() {
  const at = new Date('2026-10-05T10:00:00Z');
  return {
    id: SESSION_ID,
    seller_uid: SELLER,
    batch_id: BATCH_ID,
    status: 'waiting',
    phone_label: '',
    paused: false,
    version: 1,
    created_at: at,
    last_activity_at: at,
  };
}

// Answers every query a brand-new batch makes: the previous-batch lookup, the
// open-batch lookup, then the batch/session/pairing inserts.
function fakePool({ previousDefaults = null, openBatch = null } = {}) {
  const queries = [];
  const client = {
    async query(text, values) {
      const sql = String(text);
      queries.push({ text: sql, values: values || [] });
      if (/coalesce\(defaults->>'location'/.test(sql)) {
        return { rows: previousDefaults ? [{ defaults: previousDefaults }] : [] };
      }
      if (/status = 'open'/.test(sql) && /for update/.test(sql)) {
        return { rows: openBatch ? [openBatch] : [] };
      }
      if (/insert into public\.scan_batches/.test(sql)) {
        return {
          rows: [{
            id: BATCH_ID,
            seller_uid: SELLER,
            status: 'open',
            defaults: values[1],
            defaults_version: 1,
            defaults_history: [],
            item_seq: 0,
            item_position: 0,
          }],
        };
      }
      if (/insert into public\.scan_rate_limits/.test(sql)) return { rows: [{ hits: 1 }] };
      if (/insert into public\.scan_sessions/.test(sql)) return { rows: [sessionRow()] };
      if (/insert into public\.scan_pairings/.test(sql)) {
        return { rows: [{ pin: values[0], qr_secret: values[2], expires_at: values[3] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { queries, connect: async () => client };
}

function batchInsert(pool) {
  return pool.queries.find((q) => /insert into public\.scan_batches/.test(q.text));
}

test('a new batch copies location and stack size from the last box', async () => {
  const pool = fakePool({
    previousDefaults: {
      location: 'megaevoluzionietb',
      stackSize: 80,
      stack: 104,
      startPosition: 9,
      condition: 'MP',
    },
  });
  const store = createStore({ pool, randomInt: () => 0 });
  await store.startSession({ sellerUid: SELLER });

  const insert = batchInsert(pool);
  assert.ok(insert, 'the batch insert ran');
  const defaults = insert.values[1];
  assert.equal(defaults.location, 'megaevoluzionietb');
  assert.equal(defaults.stackSize, 80);
  // The desk works the cursor out from live stock; the old cursor is not copied.
  assert.equal(defaults.stack, 1);
  assert.equal(defaults.startPosition, 1);
  assert.equal(defaults.condition, 'NM');
  assert.deepEqual(defaults, {
    ...DEFAULT_BATCH_DEFAULTS,
    location: 'megaevoluzionietb',
    stackSize: 80,
  });
});

test('no previous box starts the batch on the plain defaults', async () => {
  const pool = fakePool();
  const store = createStore({ pool, randomInt: () => 0 });
  await store.startSession({ sellerUid: SELLER });

  const insert = batchInsert(pool);
  assert.ok(insert, 'the batch insert ran');
  assert.equal(insert.values[1].location, '');
  assert.deepEqual(insert.values[1], { ...DEFAULT_BATCH_DEFAULTS });
});

test('an already-open batch is reused, so no batch row is inserted', async () => {
  const openBatch = {
    id: BATCH_ID,
    seller_uid: SELLER,
    status: 'open',
    defaults: { location: 'box1' },
    defaults_version: 1,
    defaults_history: [],
    item_seq: 0,
    item_position: 0,
  };
  const pool = fakePool({ openBatch });
  const store = createStore({ pool, randomInt: () => 0 });
  await store.startSession({ sellerUid: SELLER });

  assert.equal(batchInsert(pool), undefined, 'the open batch is reused');
});
