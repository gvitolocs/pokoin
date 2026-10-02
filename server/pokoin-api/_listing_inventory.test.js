'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { applyDecrement, decrementHttpStatus, DECREMENT_SQL } = require('./_listing_inventory');

test('decrement SQL owns the row and the remaining quantity in one statement', () => {
  assert.match(DECREMENT_SQL, /for update/);
  assert.match(DECREMENT_SQL, /locked\.seller_uid = \$2/);
  assert.match(DECREMENT_SQL, /locked\.quantity_available >= \$3/);
  assert.doesNotMatch(DECREMENT_SQL, /greatest\s*\(/i);
});

test('the listings handler authenticates before decrement and passes that uid', () => {
  const src = fs.readFileSync(path.join(__dirname, 'marketplace-listings.js'), 'utf8');
  const getBranch = src.indexOf("if (req.method === 'GET')");
  const postAuth = src.indexOf('const decoded = await verifyBearerToken(req);', getBranch);
  const decrement = src.indexOf("action === 'decrement'", postAuth);
  assert.ok(postAuth > getBranch);
  assert.ok(decrement > postAuth);
  assert.match(src.slice(decrement, decrement + 400), /decrementListing\(req, id, decoded\.uid\)/);
});

test('owner can decrement and another user cannot', () => {
  const row = { id: '9', seller_uid: 'owner', quantity_available: 2, status: 'active' };
  assert.equal(applyDecrement(row, { sellerUid: 'other', quantity: 1 }).outcome, 'forbidden');
  assert.equal(row.quantity_available, 2);
  assert.equal(applyDecrement(row, { sellerUid: 'owner', quantity: 1 }).outcome, 'updated');
  assert.equal(row.quantity_available, 1);
  assert.equal(decrementHttpStatus('forbidden'), 404);
  assert.equal(decrementHttpStatus('updated'), 200);
});

test('unauthenticated and invalid quantities are rejected before a write', () => {
  assert.equal(applyDecrement({ seller_uid: 'owner', quantity_available: 1 }, { sellerUid: '', quantity: 1 }).outcome, 'forbidden');
  assert.equal(applyDecrement({ seller_uid: 'owner', quantity_available: 1 }, { sellerUid: 'owner', quantity: 0 }).outcome, 'invalid');
  assert.equal(applyDecrement(null, { sellerUid: 'owner', quantity: 1 }).outcome, 'missing');
  assert.equal(decrementHttpStatus('invalid'), 400);
  assert.equal(decrementHttpStatus('missing'), 404);
});

test('sold-out and oversell stop at zero', () => {
  const row = { seller_uid: 'owner', quantity_available: 1, status: 'active' };
  assert.equal(applyDecrement(row, { sellerUid: 'owner', quantity: 1 }).outcome, 'updated');
  assert.equal(row.quantity_available, 0);
  assert.equal(row.status, 'sold_out');
  assert.equal(applyDecrement(row, { sellerUid: 'owner', quantity: 1 }).outcome, 'insufficient');
  assert.equal(row.quantity_available, 0);
  assert.equal(decrementHttpStatus('insufficient'), 409);
});

test('concurrent decrements cannot pass the remaining quantity', async () => {
  const row = { seller_uid: 'owner', quantity_available: 2, status: 'active' };
  let chain = Promise.resolve();
  const decrement = (quantity) => {
    const run = chain.then(() => applyDecrement(row, { sellerUid: 'owner', quantity }));
    chain = run.then(() => {}, () => {});
    return run;
  };
  const results = await Promise.all([decrement(1), decrement(1), decrement(1)]);
  const outcomes = results.map((result) => result.outcome).sort();
  assert.deepEqual(outcomes, ['insufficient', 'updated', 'updated']);
  assert.equal(row.quantity_available, 0);
  assert.equal(row.status, 'sold_out');
});
