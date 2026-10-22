import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICER,
  normalizePricer,
  planReprice,
  planUpdate,
  pricerComp,
  pricerMatches,
  pricerSummary,
  pricerTarget,
} from './pricer.js';

// The Spiderling row of 2026-10-21: a €0.14 CardTrader ask nets 25.56 PKN.
const spiderling = {
  ctMatchedPkn: 25.56, ctMatchedGrossPkn: 28, ctCheapestPkn: 25.56, ctCheapestGrossPkn: 28,
  soldMedianPkn: 30, soldMedianGrossPkn: 33, pokoinCheapestPkn: 40,
};

test('the default pricer matches the fee-exclusive CardTrader price, whole PKN, min 1', () => {
  const strategy = normalizePricer();
  assert.equal(strategy.feeExclusive, true);
  assert.equal(pricerComp(spiderling, strategy), 25.56);
  assert.equal(pricerTarget(25.56, strategy), 26);
  assert.equal(DEFAULT_PRICER.activatePaused, true);
});

test('fee-exclusive or the ask, by basis and source', () => {
  assert.equal(pricerComp(spiderling, { feeExclusive: false }), 28);
  assert.equal(pricerComp(spiderling, { basis: 'cheapest' }), 25.56);
  assert.equal(pricerComp(spiderling, { basis: 'sold' }), 30);
  assert.equal(pricerComp(spiderling, { basis: 'sold', feeExclusive: false }), 33);
  assert.equal(pricerComp(spiderling, { source: 'pokoin' }), 40);
  assert.equal(pricerComp({ soldMedianPkn: 30 }, { source: 'pokoin' }), 30, 'no Pokoin ask: the sold median');
  // An answer from before the gross fields: the net is used either way.
  assert.equal(pricerComp({ ctMatchedPkn: 25.56 }, { feeExclusive: false }), 25.56);
  assert.equal(pricerComp({}, {}), null);
  assert.equal(pricerComp(null, {}), null);
});

test('undercut, premium, rounding and a floor that rounding never breaks', () => {
  assert.equal(pricerTarget(100, { action: 'undercut', amountPct: 10, amountPkn: 1, rounding: 'none', minPkn: 0 }), 89);
  assert.equal(pricerTarget(10.5, { action: 'premium', amountPct: 20, rounding: 'integer', minPkn: 0 }), 13);
  assert.equal(pricerTarget(25.56, { rounding: 'down', minPkn: 0 }), 25);
  assert.equal(pricerTarget(25.56, { rounding: 'up', minPkn: 0 }), 26);
  assert.equal(pricerTarget(26, { rounding: 'up', minPkn: 0 }), 26, 'a whole price is not pushed up');
  assert.equal(pricerTarget(3.4, { rounding: 'down', minPkn: 3.5 }), 3.5, 'the floor wins over rounding');
  assert.equal(pricerTarget(100, { action: 'undercut', amountPct: 90, minPkn: 50 }), 50);
  assert.equal(pricerTarget(1, { action: 'undercut', amountPkn: 5, minPkn: 0 }), null, 'never 0 or below');
  assert.equal(pricerTarget(0, {}), null);
});

test('the scope: game, live or paused, condition and language', () => {
  const row = { marketplaceGame: 'riftbound', status: 'paused', condition: 'NM', language: 'EN' };
  assert.ok(pricerMatches({}, row));
  assert.ok(pricerMatches({ game: 'riftbound', status: 'paused', condition: 'NM', language: 'EN' }, row));
  assert.ok(!pricerMatches({ game: 'pokemon' }, row));
  assert.ok(!pricerMatches({ status: 'active' }, row));
  assert.ok(!pricerMatches({ condition: 'SP' }, row));
  assert.ok(!pricerMatches({ enabled: false }, row));
  assert.ok(!pricerMatches({}, { ...row, status: 'sold_out' }), 'sold out or removed listings are never repriced');
  assert.ok(pricerMatches({ game: 'pokemon' }, { status: 'active' }), 'no game is Pokémon');
});

test('the plan prices paused Card Rails rows and puts them on sale, counting the rest', () => {
  const rows = [
    { id: 'a', cardId: '801312', marketplaceGame: 'riftbound', status: 'paused', pricePkn: 0, condition: 'NM', language: 'EN' },
    { id: 'b', cardId: '801312', marketplaceGame: 'riftbound', status: 'active', pricePkn: 26, condition: 'NM', language: 'EN' },
    { id: 'c', cardId: '801320', marketplaceGame: 'riftbound', status: 'active', pricePkn: 30, condition: 'NM', language: 'EN' },
    { id: 'd', cardId: '1', marketplaceGame: 'riftbound', status: 'active', pricePkn: 30, condition: 'NM', language: 'EN' },
  ];
  const comps = { 801312: spiderling, 801320: { ctMatchedPkn: 19.56, ctMatchedGrossPkn: 22 } };
  const { plan, scoped, noComp, unchanged } = planReprice(rows, (row) => comps[row.cardId], {});
  assert.equal(scoped, 4);
  assert.equal(noComp, 1);
  assert.equal(unchanged, 1);
  assert.deepEqual(plan.map((entry) => [entry.row.id, entry.current, entry.target, entry.activate]), [['a', 0, 26, true], ['c', 30, 20, false]]);
  assert.deepEqual(planUpdate(plan[0]), { pricePkn: 26, status: 'active' });
  assert.deepEqual(planUpdate(plan[1]), { pricePkn: 20 });
  assert.equal(plan[0].askPkn, 28, 'the CardTrader ask is shown beside the net');
  const keepPaused = planReprice(rows, (row) => comps[row.cardId], { activatePaused: false });
  assert.equal(keepPaused.plan[0].activate, false);
});

test('summary line', () => {
  assert.equal(
    pricerSummary({ action: 'undercut', amountPct: 5, game: 'riftbound', status: 'paused' }),
    'CardTrader · same card and facets · net of CardTrader fees · undercut 5% · whole PKN · min 1 PKN · riftbound · paused only',
  );
});
