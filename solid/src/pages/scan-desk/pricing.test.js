import assert from 'node:assert/strict';
import test from 'node:test';
// Relative, not @market: node --test loads these without Vite's alias.
import { currencyContext, formatLocal, pknToLocal } from '../../../../market/src/pricer.js';
import {
  batchHasPricing,
  effectiveRowPricing,
  pricingApplyBodies,
  pricingChoicePatch,
  pricingChoiceValue,
  pricingFailedLine,
  pricingHint,
  pricingOptions,
  pricingResultLine,
  rowIsPriced,
  rowOwnPricing,
  rowPricingChip,
  rowPricingPatch,
  sumPricingAnswers,
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

test('a currency context localizes the strategy names in the labels', () => {
  const ctx = currencyContext({ currency: 'EUR' });
  const name = `Undercut by ${formatLocal(pknToLocal(5, ctx), ctx)}`;
  const data = {
    strategies: [{ id: 's1', name: 'Undercut by 5 PKN' }, { id: 's2', name: 'Match' }],
    groups: [{ id: 'g1', name: 'Bulk', strategyId: 's1' }],
  };
  const out = pricingOptions(data, {}, ctx);
  assert.deepEqual(out.groups, [{ value: 'group:g1', label: `Bulk · ${name}` }], 'the group name stays as saved');
  assert.deepEqual(out.strategies.map((o) => o.label), [name, 'Match']);
  assert.deepEqual(rowPricingChip({ pricing: { strategyId: 's1' } }, {}, data, ctx), { label: name, kind: 'own' });
  assert.deepEqual(rowPricingChip({ pricing: { groupId: 'g1' } }, {}, data, ctx), { label: 'Bulk', kind: 'own' });
  assert.deepEqual(rowPricingChip({ pricing: { strategyId: 's1' } }, {}, data), { label: 'Undercut by 5 PKN', kind: 'own' }, 'no context: as saved');
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

test('apply bodies: one per group with every listing that joined it, one per strategy for unpriced rows', () => {
  const rowPricing = [
    { listingId: 'l1', itemId: 'i1', priced: false, groupId: 'g1' },
    { listingId: 'l2', itemId: 'i2', priced: true, groupId: 'g1' },
    { listingId: 'l3', itemId: 'i3', priced: false, strategyId: 's1' },
    { listingId: 'l4', itemId: 'i4', priced: true, strategyId: 's1' },
    { listingId: 'l5', itemId: 'i5', priced: false, strategyId: 's2' },
    { listingId: null, itemId: 'i6', priced: false, groupId: 'g1' },
  ];
  assert.deepEqual(pricingApplyBodies({ rowPricing }), [
    { groupId: 'g1', listingIds: ['l1', 'l2'] },
    { strategyId: 's1', listingIds: ['l3'] },
    { strategyId: 's2', listingIds: ['l5'] },
  ]);
  assert.deepEqual(pricingApplyBodies({ rowPricing: [{ listingId: 'l4', priced: true, strategyId: 's1' }] }), []);
  // An answer from before rowPricing: the batch's choice over every created listing.
  const created = [{ listingId: 'l1' }, { listingId: null }, { listingId: 'l2' }];
  assert.deepEqual(pricingApplyBodies({ pricing: { groupId: 'g1' }, created }), [{ groupId: 'g1', listingIds: ['l1', 'l2'] }]);
  assert.deepEqual(pricingApplyBodies({ pricing: null, created }), []);
  assert.deepEqual(sumPricingAnswers([{ applied: 2, activated: 1, noComp: 0, failed: [] }, { applied: 1, activated: 1, noComp: 2, failed: [{ listingId: 'x' }] }]),
    { applied: 3, activated: 2, noComp: 2, failed: [{ listingId: 'x' }] });
});

test('a row is priced by its own choice, else the batch default; none opts out', () => {
  const batch = { pricingGroupId: 'g1' };
  assert.equal(rowOwnPricing({ pricing: null }), null);
  assert.deepEqual(rowOwnPricing({ pricing: { strategyId: ' s1 ' } }), { strategyId: 's1' });
  assert.deepEqual(rowOwnPricing({ pricing: { none: true, groupId: 'g1' } }), { none: true });
  assert.deepEqual(effectiveRowPricing({}, batch), { groupId: 'g1' });
  assert.deepEqual(effectiveRowPricing({ pricing: { strategyId: 's1' } }, batch), { strategyId: 's1' });
  assert.equal(effectiveRowPricing({ pricing: { none: true } }, batch), null);
  assert.equal(rowIsPriced({}, {}), false);
  assert.equal(rowIsPriced({ pricing: { strategyId: 's1' } }, {}), true);
  const data = { strategies: [{ id: 's1', name: 'Undercut 5%' }], groups: [{ id: 'g1', name: 'Bulk', strategyId: 's1' }] };
  assert.deepEqual(rowPricingChip({}, batch, data), { label: 'Bulk', kind: 'batch' });
  assert.deepEqual(rowPricingChip({ pricing: { strategyId: 's1' } }, batch, data), { label: 'Undercut 5%', kind: 'own' });
  assert.deepEqual(rowPricingChip({ pricing: { none: true } }, batch, data), { label: 'None', kind: 'none' });
  assert.deepEqual(rowPricingChip({}, {}, data), { label: 'Suggested', kind: 'batch' });
  assert.equal(rowPricingPatch({ kind: 'batch' }), null);
  assert.deepEqual(rowPricingPatch({ kind: 'none' }), { none: true });
  assert.deepEqual(rowPricingPatch({ kind: 'group', id: 'g1' }), { groupId: 'g1' });
  assert.deepEqual(rowPricingPatch({ kind: 'strategy', id: 's1' }), { strategyId: 's1' });
});

test('result and failure lines', () => {
  assert.equal(
    pricingResultLine({ applied: 3, activated: 2, noComp: 1, failed: [] }),
    'Priced 3 cards · 2 put on sale · 1 has no market price',
  );
  assert.equal(pricingResultLine({ applied: 1, activated: 0, noComp: 4, failed: [{}] }), 'Priced 1 card · 0 put on sale · 4 have no market price · 1 failed');
  assert.equal(pricingFailedLine([{ groupId: 'g1' }]), 'Pricing failed for 1 choice. Cards in a group stay there and can be priced from the Pricer tab.');
  assert.equal(pricingFailedLine([{ strategyId: 's1' }, { strategyId: 's2' }]), 'Pricing failed for 2 choices. Unpriced cards are paused and can be priced from the Pricer tab.');
});
