import assert from 'node:assert/strict';
import test from 'node:test';
import { previewComps, previewGroups, previewListings, previewStrategies } from '../../pages/mypokoin-preview-fixture.js';
import { applyPricingLocal, deleteGroup, deleteStrategy, saveGroup, saveStrategy, snapshot } from './pricer-local.js';

const fixture = () => ({ strategies: previewStrategies(), groups: previewGroups().groups, pairs: previewGroups().memberships });

test('the preview fixture: six named strategies, three groups, one daily, one never applied', () => {
  const data = snapshot(fixture());
  assert.deepEqual(data.strategies.map((entry) => entry.name), ['Undercut 5% · CardTrader net', 'Match CardTrader · same language', 'Sold median +10%', 'Cardmarket trend −3%', 'TCGplayer market', 'Undercut Cardmarket pro sellers 2%']);
  for (const strategy of previewStrategies()) {
    for (const scope of ['condition', 'language', 'enabled', 'game', 'status']) assert.equal(scope in strategy, false, scope);
  }
  assert.deepEqual(data.groups.map((group) => group.listingCount), [3, 4, 1]);
  assert.equal(data.groups.filter((group) => group.autoDaily).length, 1);
  assert.equal(data.groups.filter((group) => !group.lastAppliedAt).length, 1);
  assert.deepEqual(data.strategies[0].groupNames, ['Base Set holos']);
  assert.match(data.strategies[0].summary, /all exact · net of CardTrader fees · undercut 5%/);
  assert.match(data.strategies[1].summary, /same language/);
  assert.match(data.strategies[5].summary, /Cardmarket sellers · cheapest professional offer · all exact · undercut 2%/);
  const listed = new Set(previewListings().map((row) => row.id));
  assert.ok(data.memberships.every(([id]) => listed.has(id)));
});

test('saving a group creates, fills, moves and removes', () => {
  let state = fixture();
  const created = saveGroup(state, { group: { name: 'New pile', strategyId: 'preview-strategy-2', autoDaily: false }, add: ['preview-list-8', 'preview-list-1'] });
  state = created.state;
  assert.equal(created.added, 2);
  assert.equal(snapshot(state).groups.find((group) => group.id === created.groupId).listingCount, 2);
  // preview-list-1 left Base Set holos.
  assert.equal(snapshot(state).groups[0].listingCount, 2);
  const moved = saveGroup(state, { groupId: 'preview-group-3', add: ['preview-list-8'] });
  assert.equal(moved.state.pairs.find(([id]) => id === 'preview-list-8')[1], 'preview-group-3');
  const removed = saveGroup(moved.state, { remove: ['preview-list-8', 'nope'] });
  assert.equal(removed.removed, 1);
  assert.throws(() => saveGroup(state, { group: { name: 'base set HOLOS', strategyId: 'preview-strategy-1' } }), /already have a group/);
  assert.throws(() => saveGroup(state, { group: { name: ' ', strategyId: 'preview-strategy-1' } }), /Give the group a name/);
  const renamed = saveGroup(state, { group: { id: 'preview-group-1', name: 'Holos', strategyId: 'preview-strategy-2', autoDaily: false } });
  const group = renamed.state.groups.find((entry) => entry.id === 'preview-group-1');
  assert.equal(group.name, 'Holos');
  assert.equal(group.lastAppliedAt, '2026-11-03T05:00:00.000Z', 'an edit keeps the last apply');
  const gone = deleteGroup(state, 'preview-group-2');
  assert.equal(gone.pairs.some(([, id]) => id === 'preview-group-2'), false);
});

test('strategies: unique names, and a strategy in use is refused', () => {
  const state = fixture();
  assert.throws(() => saveStrategy(state, { name: 'match cardtrader · SAME language' }), /already have a strategy/);
  const saved = saveStrategy(state, { name: 'Match CardTrader copy', source: 'pokoin' });
  assert.equal(saved.state.strategies.length, 7);
  assert.throws(() => deleteStrategy(state, 'preview-strategy-1'), (err) => err.code === 'strategy_in_use' && /Base Set holos/.test(err.message));
  const unused = deleteStrategy(saved.state, saved.savedId);
  assert.equal(unused.strategies.length, 6);
});

test('apply plans with the fixture comps and, when not dry, reprices the rows', () => {
  const state = fixture();
  const rows = previewListings();
  const dry = applyPricingLocal(state, rows, previewComps(), { groupId: 'preview-group-1', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.scoped, 3);
  assert.equal('rows' in dry, false);
  const pikachu = dry.plan.find((entry) => entry.listingId === 'preview-list-1');
  // Net 431.94 − 5% = 410.34 → 410.
  assert.deepEqual([pikachu.compPkn, pikachu.askPkn, pikachu.target, pikachu.current], [431.94, 460, 410, 420]);
  const mewtwo = dry.plan.find((entry) => entry.listingId === 'preview-list-3');
  assert.equal(mewtwo.activate, true, 'paused Mewtwo goes on sale');
  const done = applyPricingLocal(state, rows, previewComps(), { groupId: 'preview-group-1', dryRun: false }, new Date('2026-11-04T10:00:00Z'));
  assert.equal(done.applied, dry.plan.length);
  assert.equal(done.rows.find((row) => row.id === 'preview-list-1').pricePkn, 410);
  assert.equal(done.rows.find((row) => row.id === 'preview-list-3').status, 'active');
  const group = done.state.groups.find((entry) => entry.id === 'preview-group-1');
  assert.equal(group.lastAppliedAt, '2026-11-04T10:00:00.000Z');
  assert.equal(group.lastApplied.trigger, 'manual');
  // Sold median: the fixture has no sold comps, so nothing is guessed.
  const sold = applyPricingLocal(state, rows, previewComps(), { groupId: 'preview-group-3', dryRun: true });
  assert.deepEqual([sold.plan.length, sold.noComp], [0, 1]);
});

test('selective apply: a strategy over picked listings, or a group over picked members', () => {
  const state = fixture();
  const rows = previewListings();
  const picked = ['preview-list-1', 'preview-list-5', 'preview-list-8'];
  const dry = applyPricingLocal(state, rows, previewComps(), { strategyId: 'preview-strategy-1', listingIds: picked, dryRun: true });
  assert.equal(dry.scoped, 3, 'grouped or not, the picked listings are priced');
  assert.deepEqual(dry.plan.map((entry) => entry.listingId).sort(), picked.slice().sort());
  const done = applyPricingLocal(state, rows, previewComps(), { strategyId: 'preview-strategy-1', listingIds: picked, dryRun: false });
  assert.equal(done.rows.find((row) => row.id === 'preview-list-5').pricePkn, 24);
  assert.equal(done.rows.find((row) => row.id === 'preview-list-2').pricePkn, 1800, 'other listings keep their price');
  assert.equal(done.state, state, 'no group is stamped');
  const groupPart = applyPricingLocal(state, rows, previewComps(), { groupId: 'preview-group-1', listingIds: ['preview-list-1', 'preview-list-4'], dryRun: true });
  assert.deepEqual(groupPart.plan.map((entry) => entry.listingId), ['preview-list-1'], 'only members of the group');
  assert.throws(() => applyPricingLocal(state, rows, previewComps(), { strategyId: 'preview-strategy-1', dryRun: true }), /Pick the listings/);
});
