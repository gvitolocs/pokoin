import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STRATEGY,
  MATCH_ANY,
  MATCH_EXACT,
  PRICER_BASES,
  PRICER_MATCHES,
  PRICER_SOURCES,
  effectiveMatch,
  isAllExact,
  pricerBases,
  sourceHasFees,
  sourceSwitches,
  switchNote,
  matchKey,
  matchSummary,
  floorPriceRounded,
  lastAppliedLine,
  membershipMap,
  nameProblem,
  normalizeStrategy,
  planReprice,
  planUpdate,
  strategyComp,
  strategyExample,
  strategySummary,
  strategyTarget,
  ungroupedCount,
} from './pricer.js';

// The Spiderling comp of 2026-10-21: a €0.14 CardTrader ask nets 25.56 PKN.
// The same numbers as pokoin-rust/crates/external/src/pricing.rs tests.
const spiderling = {
  ctMatchedPkn: 25.56, ctMatchedGrossPkn: 28, ctCheapestPkn: 25.56, ctCheapestGrossPkn: 28,
  soldMedianPkn: 30, soldMedianGrossPkn: 33, pokoinCheapestPkn: 40,
};

test('a new strategy matches the fee-exclusive CardTrader price, whole PKN, min 1', () => {
  const strategy = normalizeStrategy(DEFAULT_STRATEGY);
  assert.equal(strategyComp(spiderling, strategy), 25.56);
  assert.equal(strategyTarget(25.56, strategy), 26);
  assert.equal(strategy.activatePaused, true);
  assert.equal(normalizeStrategy({ name: '  Undercut  ' }).name, 'Undercut');
  for (const gone of ['game', 'status', 'condition', 'language', 'enabled']) {
    assert.ok(!(gone in normalizeStrategy({ game: 'pokemon', status: 'paused', condition: 'NM' })), `${gone} is not a strategy field`);
  }
});

test('names are required and unique, ignoring case', () => {
  const others = [{ id: 'st_a', name: 'Undercut 5%' }];
  assert.equal(nameProblem('', '', others), 'Give the strategy a name.');
  assert.equal(nameProblem(' ', '', others, 'group'), 'Give the group a name.');
  assert.equal(nameProblem(' undercut 5% ', 'st_b', others), 'You already have a strategy named “undercut 5%”.');
  assert.equal(nameProblem('UNDERCUT 5%', 'st_a', others), '', 'its own name is no clash');
  assert.equal(nameProblem('Match', '', others), '');
});

test('the comp by source, basis and fees', () => {
  assert.equal(strategyComp(spiderling, { feeExclusive: false }), 28);
  assert.equal(strategyComp(spiderling, { basis: 'cheapest' }), 25.56);
  assert.equal(strategyComp(spiderling, { basis: 'sold' }), 30);
  assert.equal(strategyComp(spiderling, { basis: 'sold', feeExclusive: false }), 33);
  assert.equal(strategyComp(spiderling, { source: 'pokoin' }), 40);
  assert.equal(strategyComp({ soldMedianPkn: 30 }, { source: 'pokoin' }), 30, 'no Pokoin ask: the sold median');
  assert.equal(strategyComp({ ctMatchedPkn: 25.56 }, { feeExclusive: false }), 25.56, 'no gross field: the net');
  assert.equal(strategyComp({}, {}), null);
  assert.equal(strategyComp(null, {}), null);
});

test('the toggles pick their offer from the comp, as the server does', () => {
  // Asks 28 (exact), 20 (same condition and language), 15 (any copy).
  const comp = {
    ctMatchedPkn: 25.56, ctMatchedGrossPkn: 28, ctCheapestPkn: 13.5, ctCheapestGrossPkn: 15,
    ctMatch: { CLFE: { grossPkn: 28, pkn: 25.56 }, CL: { grossPkn: 20, pkn: 18.2 }, '': { grossPkn: 15, pkn: 13.5 } },
  };
  const toggles = (condition, language, finish, firstEdition) => ({ match: { condition, language, finish, firstEdition } });
  assert.equal(strategyComp(comp, toggles(true, true, true, true)), 25.56);
  assert.equal(strategyComp(comp, toggles(true, true, false, false)), 18.2);
  assert.equal(strategyComp(comp, { ...toggles(true, true, false, false), feeExclusive: false }), 20);
  assert.equal(strategyComp(comp, toggles(false, false, false, false)), 13.5);
  assert.equal(strategyComp(comp, toggles(false, true, false, false)), null, 'no offer in that language: no price');
  const old = { ctMatchedPkn: 25.56, ctCheapestPkn: 13.5 };
  assert.equal(strategyComp(old, toggles(true, true, true, true)), 25.56);
  assert.equal(strategyComp(old, toggles(false, false, false, false)), 13.5);
  assert.equal(strategyComp(old, toggles(true, false, false, false)), null);
  assert.equal(strategyComp({ soldMedianPkn: 30, ctMatch: {} }, { basis: 'sold', match: { condition: false } }), 30);
  // Saved before the toggles: 'matched' is all exact, 'cheapest' any copy.
  assert.deepEqual(normalizeStrategy({ basis: 'matched' }).match, MATCH_EXACT);
  assert.deepEqual(normalizeStrategy({ basis: 'cheapest' }).match, MATCH_ANY);
  assert.equal(normalizeStrategy({ basis: 'cheapest' }).basis, 'offers');
  assert.equal(matchKey({ language: true, finish: true }), 'LF');
  assert.equal(matchSummary(MATCH_EXACT), 'all exact');
  assert.equal(matchSummary(MATCH_ANY), 'any copy');
  assert.equal(matchSummary({ condition: true }), 'same condition');
  assert.equal(matchSummary({ condition: true, language: true, firstEdition: true }), 'same condition, language and 1st edition');
  assert.ok(isAllExact(MATCH_EXACT) && !isAllExact({ ...MATCH_EXACT, finish: false }));
  assert.ok(!PRICER_BASES.concat(PRICER_MATCHES).some((entry) => /facet/i.test(`${entry.label} ${entry.hint || ''}`)), 'no "facets" in the UI copy');
});

test('the shared examples (pricer.vectors.json) hold, as on the server', async () => {
  const { readFile } = await import('node:fs/promises');
  const vectors = JSON.parse(await readFile(new URL('./pricer.vectors.json', import.meta.url), 'utf8'));
  assert.ok(vectors.cases.length >= 10);
  for (const [index, example] of vectors.cases.entries()) {
    const comp = vectors.comps[example.comp];
    const compPkn = strategyComp(comp, example.strategy);
    assert.equal(compPkn, example.compPkn, `case ${index}: comp`);
    assert.equal(strategyTarget(compPkn, example.strategy), example.target, `case ${index}: target`);
  }
});

test('the fixed-point rounding core is the server one', () => {
  const S = 100_000_000;
  const t = 25 * S + 56 * S / 100;
  assert.equal(floorPriceRounded(t, 'integer', 0), 26 * S);
  assert.equal(floorPriceRounded(t, 'down', 0), 25 * S);
  assert.equal(floorPriceRounded(t, 'up', 0), 26 * S);
  assert.equal(floorPriceRounded(26 * S, 'up', 0), 26 * S);
  assert.equal(floorPriceRounded(t, 'none', 0), t);
  assert.equal(floorPriceRounded(-S / 2, 'up', -10 * S), 0);
  assert.equal(floorPriceRounded(-S / 2, 'down', -10 * S), -S);
  assert.equal(floorPriceRounded(-S / 2, 'down', 0), 0, 'the floor lifts it');
});

test('target math matches the server', () => {
  const t = (comp, s) => strategyTarget(comp, s);
  assert.equal(t(100, { action: 'undercut', amountPct: 10, amountPkn: 1 }), 89);
  assert.equal(t(10.5, { action: 'premium', amountPct: 20, rounding: 'integer' }), 13);
  assert.equal(t(25.56, { rounding: 'integer', minPkn: 1 }), 26);
  assert.equal(t(25.56, { rounding: 'down' }), 25);
  assert.equal(t(25.56, { rounding: 'up' }), 26);
  assert.equal(t(26, { rounding: 'up' }), 26, 'a whole price is not pushed up');
  assert.equal(t(3.4, { rounding: 'down', minPkn: 3.5 }), 3.5, 'the floor wins over rounding');
  assert.equal(t(100, { action: 'undercut', amountPct: 90, minPkn: 50 }), 50);
  assert.equal(t(1, { action: 'undercut', amountPkn: 5 }), null, 'never 0 or below');
  assert.equal(t(25.56789, { rounding: 'none' }), 25.57, 'exact is cents');
  assert.equal(t(1e13, {}), null, 'beyond the proofs\' range');
  assert.equal(t(null, {}), null);
  assert.equal(t(0, {}), null);
});

test('the worked example shows each step', () => {
  assert.deepEqual(strategyExample(25.56, { action: 'undercut', amountPct: 5, rounding: 'integer', minPkn: 1 }), { comp: 25.56, adjusted: 24.28, target: 24 });
  assert.equal(strategyExample(null, {}), null);
});

test('the plan prices paused rows, puts them on sale and counts the rest', () => {
  const rows = [
    { id: 'a', cardId: '801312', status: 'paused', pricePkn: 0 },
    { id: 'b', cardId: '801312', status: 'active', pricePkn: 26 },
    { id: 'c', cardId: '801320', status: 'active', pricePkn: 30 },
    { id: 'd', cardId: '1', status: 'active', pricePkn: 30 },
    { id: 'e', cardId: '801312', status: 'sold_out', pricePkn: 30 },
  ];
  const comps = { 801312: spiderling, 801320: { ctMatchedPkn: 19.56, ctMatchedGrossPkn: 22 } };
  const strategy = { rounding: 'integer', minPkn: 1, activatePaused: true };
  const { plan, scoped, noComp, unchanged } = planReprice(rows, (row) => comps[row.cardId], strategy);
  assert.equal(scoped, 4, 'sold out is skipped');
  assert.equal(noComp, 1);
  assert.equal(unchanged, 1);
  assert.deepEqual(plan.map((entry) => [entry.row.id, entry.current, entry.target, entry.activate]), [['a', 0, 26, true], ['c', 30, 20, false]]);
  assert.deepEqual(planUpdate(plan[0]), { pricePkn: 26, status: 'active' });
  assert.deepEqual(planUpdate(plan[1]), { pricePkn: 20 });
  assert.equal(plan[0].askPkn, 28, 'the CardTrader ask is shown beside the net');
  const keepPaused = planReprice(rows, (row) => comps[row.cardId], { ...strategy, activatePaused: false });
  assert.equal(keepPaused.plan[0].activate, false);
});

test('summary line matches the server', () => {
  assert.equal(
    strategySummary({ source: 'cardtrader', action: 'undercut', amountPct: 5, rounding: 'integer', minPkn: 1 }),
    'CardTrader · all exact · net of CardTrader fees · undercut 5% · whole PKN · min 1 PKN',
  );
  assert.equal(
    strategySummary({ source: 'pokoin', basis: 'sold', action: 'premium', amountPct: 10, amountPkn: 2.5 }),
    'Pokoin · sold median (90 days) · same condition and language · +10% + 2.5 PKN',
  );
  assert.equal(strategySummary({ source: 'pokoin', action: 'match' }), 'Pokoin · cheapest Pokoin ask · match');
  assert.equal(
    strategySummary({ source: 'cardtrader', basis: 'sold', action: 'match', match: MATCH_ANY }),
    'CardTrader · sold median (30 days) · any copy · net of CardTrader fees · match',
  );
  assert.equal(
    strategySummary({ source: 'cardmarket', basis: 'avg7', action: 'undercut', amountPct: 3 }),
    'Cardmarket · 7-day average · same finish · undercut 3%',
  );
  assert.equal(
    strategySummary({ source: 'tcgplayer', action: 'match', rounding: 'up' }),
    'TCGplayer · market price (USD → EUR) · same finish and 1st edition · match · rounded up',
  );
});

test('each source has its bases and the toggles it can honour', () => {
  assert.deepEqual(pricerBases('cardmarket').map((b) => b.id), ['trend', 'low', 'avg1', 'avg7', 'avg30']);
  assert.deepEqual(pricerBases('tcgplayer').map((b) => b.id), ['market', 'low', 'mid']);
  assert.deepEqual(pricerBases('nope').map((b) => b.id), ['offers', 'sold']);
  assert.equal(normalizeStrategy({ source: 'cardmarket', basis: 'sold' }).basis, 'trend', 'not a Cardmarket basis: its default');
  assert.equal(normalizeStrategy({ source: 'tcgplayer', basis: 'low' }).basis, 'low');
  assert.equal(normalizeStrategy({ source: 'cardtrader', basis: 'trend' }).basis, 'offers');
  assert.deepEqual(sourceSwitches('tcgplayer', 'market'), { condition: false, language: false, finish: true, firstEdition: true });
  assert.deepEqual(sourceSwitches('pokoin', 'sold'), { condition: true, language: true, finish: false, firstEdition: false });
  assert.deepEqual(sourceSwitches('pokoin', 'offers'), MATCH_ANY);
  assert.deepEqual(sourceSwitches('cardtrader', 'sold'), MATCH_EXACT);
  assert.deepEqual(
    effectiveMatch({ source: 'tcgplayer', match: { condition: true, language: true, finish: false, firstEdition: true } }),
    { condition: false, language: false, finish: false, firstEdition: true },
  );
  assert.equal(switchNote('cardmarket'), 'Not in Cardmarket’s data');
  assert.equal(sourceHasFees('cardtrader'), true);
  assert.equal(sourceHasFees('tcgplayer'), false);
  assert.ok(!PRICER_SOURCES.flatMap((s) => pricerBases(s.id)).some((b) => /facet/i.test(`${b.label} ${b.hint}`)), 'no "facets" in the UI copy');
});

test('memberships, ungrouped listings and the last-apply line', () => {
  const members = membershipMap([['l1', 'pg_a'], ['l2', 'pg_b'], ['bad'], null]);
  assert.equal(members.get('l1'), 'pg_a');
  assert.equal(members.size, 2);
  assert.equal(ungroupedCount([{ id: 'l1' }, { id: 'l3' }, { id: 'l4', status: 'sold_out' }, { id: 'l5', status: 'paused' }], members), 2);
  assert.equal(lastAppliedLine({}), 'Never applied');
  assert.equal(lastAppliedLine({ lastAppliedAt: '2026-11-04T14:02:00.000Z', lastApplied: { trigger: 'daily', changed: 3 } }), 'Repriced daily 4 Nov · 3 prices');
  assert.equal(lastAppliedLine({ lastAppliedAt: '2026-11-03T10:00:00.000Z', lastApplied: { trigger: 'batch', changed: 1 } }), 'Priced on arrival 3 Nov · 1 price');
});
