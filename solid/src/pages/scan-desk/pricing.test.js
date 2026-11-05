import assert from 'node:assert/strict';
import test from 'node:test';
import {
  batchHasPricing,
  pricingApplyBody,
  pricingChoicePatch,
  pricingChoiceValue,
  pricingFailedLine,
  pricingHint,
  pricingOptions,
  pricingResultLine,
} from './pricing.js';

test('select value and defaults patch round-trip', () => {
  assert.equal(pricingChoiceValue({ pricingGroupId: 'g1', pricingStrategyId: '' }), 'group:g1');
  assert.equal(pricingChoiceValue({ pricingGroupId: '', pricingStrategyId: 's1' }), 'strategy:s1');
  assert.equal(pricingChoiceValue({ pricingGroupId: 'g1', pricingStrategyId: 's1' }), 'group:g1');
  assert.equal(pricingChoiceValue({}), '');
  assert.deepEqual(pricingChoicePatch('group:g1'), { pricingGroupId: 'g1', pricingStrategyId: '' });
  assert.deepEqual(pricingChoicePatch('strategy:s1'), { pricingGroupId: '', pricingStrategyId: 's1' });
  assert.deepEqual(pricingChoicePatch(''), { pricingGroupId: '', pricingStrategyId: '' });
  assert.equal(batchHasPricing({ pricingStrategyId: 's1' }), true);
  assert.equal(batchHasPricing({ game: 'pokemon' }), false);
});

test('options list groups with their strategy, then strategies', () => {
  const data = {
    strategies: [{ id: 's1', name: 'Undercut 5%' }, { id: 's2', name: 'Match' }],
    groups: [{ id: 'g1', name: 'Bulk', strategyId: 's1' }],
  };
  const out = pricingOptions(data, {});
  assert.deepEqual(out.groups, [{ value: 'group:g1', label: 'Bulk · Undercut 5%' }]);
  assert.deepEqual(out.strategies.map((o) => o.label), ['Undercut 5%', 'Match']);
  const missing = pricingOptions(data, { pricingGroupId: 'gone' });
  assert.deepEqual(missing.groups.at(-1), { value: 'group:gone', label: 'Group not found' });
  assert.deepEqual(pricingOptions(null, {}), { groups: [], strategies: [] });
});

test('hint names the group only for a group', () => {
  assert.equal(pricingHint({}), '');
  assert.equal(
    pricingHint({ pricingGroupId: 'g1' }),
    "Unpriced cards get the strategy's price when the batch loads and go on sale. Cards with no market price stay paused in the group.",
  );
  assert.equal(
    pricingHint({ pricingStrategyId: 's1' }),
    "Unpriced cards get the strategy's price when the batch loads and go on sale. Cards with no market price stay paused.",
  );
});

test('apply body comes from the submit result', () => {
  const created = [{ listingId: 'l1' }, { listingId: null }, { listingId: 'l2' }];
  assert.deepEqual(pricingApplyBody({ pricing: { groupId: 'g1' }, created }), { groupId: 'g1', listingIds: ['l1', 'l2'] });
  assert.deepEqual(pricingApplyBody({ pricing: { strategyId: 's1' }, created }), { strategyId: 's1', listingIds: ['l1', 'l2'] });
  assert.equal(pricingApplyBody({ pricing: null, created }), null);
  assert.equal(pricingApplyBody({ pricing: { groupId: 'g1' }, created: [] }), null);
});

test('result and failure lines', () => {
  assert.equal(
    pricingResultLine({ applied: 3, activated: 2, noComp: 1, failed: [] }),
    'Priced 3 cards · 2 put on sale · 1 has no market price',
  );
  assert.equal(pricingResultLine({ applied: 1, activated: 0, noComp: 4, failed: [{}] }), 'Priced 1 card · 0 put on sale · 4 have no market price · 1 failed');
  assert.equal(pricingFailedLine({ groupId: 'g1' }), 'Pricing failed. They are in the group and can be priced from the Pricer tab.');
  assert.equal(pricingFailedLine({ strategyId: 's1' }), 'Pricing failed. Unpriced cards are paused and can be priced from the Pricer tab.');
});
