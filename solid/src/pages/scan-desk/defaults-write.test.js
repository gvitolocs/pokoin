import assert from 'node:assert/strict';
import test from 'node:test';
import { affectedKeys, applyDefaultsResponse, defaultsFailureMessage, rollbackDefaults } from './defaults-write.js';

// `setDefaults` writes optimistically and then applies the server's batch view.
// The server is last-write-wins and answers with the whole defaults object, so
// an answer of an older write used to repaint a newer choice back: "I can't
// disable the batch default". These are the rules the desk applies instead.

const view = (defaults, defaultsVersion) => ({ id: 'b1', status: 'open', defaults, defaultsVersion });

const batch = (defaults, defaultsVersion = 1) => ({
  id: 'b1',
  status: 'open',
  defaults: { condition: 'NM', language: 'EN', pricingGroupId: 'g1', pricingStrategyId: '', location: '712', ...defaults },
  defaultsVersion,
});

test('an answer older than the newest applied default is dropped', () => {
  // Two writes: Condition → LP landed (version 8) and pricing was switched to a
  // strategy; the older condition answer (version 7) arrives last.
  const prev = batch({ condition: 'LP', pricingGroupId: '', pricingStrategyId: 'S' }, 8);
  const stale = view({ ...prev.defaults, condition: 'NM', pricingGroupId: 'g1', pricingStrategyId: '' }, 7);
  const next = applyDefaultsResponse(prev, { patch: { condition: 'NM' }, view: stale });
  assert.equal(next, prev, 'nothing applied');
  assert.equal(next.defaults.condition, 'LP');
  assert.equal(next.defaults.pricingStrategyId, 'S', 'the newer choice survives');
  assert.equal(next.defaultsVersion, 8);
});

test('an answer only overwrites the keys its own write set', () => {
  // The seller switched Pricing off, then Condition; this answer is the pricing
  // write and carries the pre-change condition NM.
  const prev = batch({ condition: 'LP' }, 9);
  const next = applyDefaultsResponse(prev, {
    patch: { pricingGroupId: '', pricingStrategyId: 's1' },
    view: view({ ...prev.defaults, condition: 'NM', pricingGroupId: '', pricingStrategyId: 's1' }, 10),
  });
  assert.equal(next.defaults.condition, 'LP', 'the stale NM never lands');
  assert.equal(next.defaults.pricingStrategyId, 's1');
  assert.equal(next.defaultsVersion, 10);
});

test('a defaults answer never reopens a batch the submit closed', () => {
  const closedBatch = { ...batch({ condition: 'LP' }, 5), status: 'submitted', submitResult: { listings: 4 } };
  const next = applyDefaultsResponse(closedBatch, {
    patch: { location: 'A1' },
    view: { ...view({ ...closedBatch.defaults, location: 'A1' }, 6), status: 'open', submitResult: null },
  });
  assert.equal(next.status, 'submitted', 'the queue stays closed');
  assert.deepEqual(next.submitResult, { listings: 4 });
  assert.equal(next.defaults.location, 'A1');
});

test('the server-coupled keys of a stack-size change come back with it', () => {
  // normalize_defaults folds the position into the new divider size.
  const prev = batch({ stackSize: 10, stack: 3, startPosition: 7 }, 11);
  const next = applyDefaultsResponse(prev, {
    patch: { stackSize: 5 },
    view: view({ ...prev.defaults, stackSize: 5, stack: 6, startPosition: 2 }, 12),
  });
  assert.equal(next.defaults.stackSize, 5);
  assert.equal(next.defaults.stack, 6, 'the cursor the server settled on');
  assert.equal(next.defaults.startPosition, 2);
  assert.deepEqual([...affectedKeys({ stackSize: 5 })].sort(), ['stack', 'stackSize', 'startPosition']);
});

test('an answer with no version still cannot restore a key nobody wrote', () => {
  const prev = batch({ condition: 'LP', firstEdition: true }, 3);
  const next = applyDefaultsResponse(prev, {
    patch: { firstEdition: false },
    view: { ...view({ ...prev.defaults, firstEdition: false, condition: 'NM' }), defaultsVersion: null },
  });
  assert.equal(next.defaults.firstEdition, false);
  assert.equal(next.defaults.condition, 'LP');
  assert.equal(next.defaultsVersion, 3, 'the version the desk already has is kept');
});

test('a failed save rolls back the optimistic default and names it', () => {
  const before = batch({ condition: 'NM' }, 4);
  // The optimistic paint the desk made for condition → LP, plus a flag change
  // another control saved in between that must not be reverted.
  const optimistic = { ...before, defaults: { ...before.defaults, condition: 'LP', language: 'IT' } };
  const rolled = rollbackDefaults(optimistic, before.defaults, { condition: 'LP' });
  assert.equal(rolled.defaults.condition, 'NM', 'back to what the server has');
  assert.equal(rolled.defaults.language, 'IT', 'the other control keeps its change');
  assert.equal(defaultsFailureMessage({ condition: 'LP' }), 'Condition not saved — reverted.');
  assert.equal(defaultsFailureMessage({ pricingGroupId: '', pricingStrategyId: 's1' }), 'Pricing not saved — reverted.');
  assert.equal(defaultsFailureMessage({ mysteryField: 1 }), 'That batch default not saved — reverted.');
});

test('a key the batch did not have before a failed write is dropped again', () => {
  const before = { condition: 'NM' };
  const rolled = rollbackDefaults({ condition: 'NM', location: '712' }, before, { location: '712' });
  assert.equal(Object.prototype.hasOwnProperty.call(rolled.defaults, 'location'), false);
});

test('a missing batch view leaves the optimistic state alone', () => {
  const prev = batch({ condition: 'LP' }, 2);
  assert.equal(applyDefaultsResponse(prev, { patch: { condition: 'LP' }, view: null }), prev);
  assert.equal(applyDefaultsResponse(null, { patch: {}, view: view({}, 1) }), null);
});
