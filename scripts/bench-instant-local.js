'use strict';

/**
 * Local microbench only. Does not open Postgres, Meili, Firestore, or the Pi.
 * Production p50/p95 stay the audit curls until this code is deployed.
 */

const { performance } = require('node:perf_hooks');
const { applyDecrement } = require('../server/pokoin-api/_listing_inventory');
const { cardPageKey, searchPageKey } = require('../server/pokoin-api/_read_model_cache');

function sample(fn, n) {
  const times = [];
  for (let i = 0; i < n; i += 1) times.push(fn());
  times.sort((a, b) => a - b);
  return {
    n,
    p50: times[Math.floor(n * 0.5)],
    p95: times[Math.floor(n * 0.95)],
  };
}

const decrement = sample(() => {
  const row = { seller_uid: 'owner', quantity_available: 3, status: 'active' };
  const started = performance.now();
  applyDecrement(row, { sellerUid: 'owner', quantity: 1 });
  applyDecrement(row, { sellerUid: 'other', quantity: 1 });
  return performance.now() - started;
}, 2000);

const keys = sample(() => {
  const started = performance.now();
  cardPageKey({ cardId: '693360', lang: 'en', includeOffers: false });
  searchPageKey({ query: 'charizard', limit: 24 });
  return performance.now() - started;
}, 2000);

console.log(JSON.stringify({
  note: 'in-process only; not a deployed API measurement',
  decrementMs: decrement,
  cacheKeyMs: keys,
}, null, 2));
