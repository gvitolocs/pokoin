import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STRATEGY,
  MATCH_ANY,
  MATCH_EXACT,
  PRICER_BASES,
  PRICER_CURRENCIES,
  PRICER_MATCHES,
  PRICER_SOURCES,
  currencyContext,
  effectiveMatch,
  formatLocal,
  isAllExact,
  localToPkn,
  localizeStrategyName,
  pricerBases,
  pknToLocal,
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

test('the summary line reads the server rules with money in the display currency', () => {
  assert.equal(
    strategySummary({ source: 'cardtrader', action: 'undercut', amountPct: 5, rounding: 'integer', minPkn: 1 }),
    'CardTrader · all exact · net of CardTrader fees · undercut 5% · nearest · min €0.01',
  );
  assert.equal(
    strategySummary({ source: 'pokoin', basis: 'sold', action: 'premium', amountPct: 10, amountPkn: 2.5 }),
    'Pokoin · sold median (90 days) · same condition and language · +10% + €0.01',
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
  assert.equal(
    strategySummary({ source: 'cardmarketoffers', action: 'undercut', amountPct: 2 }),
    'Cardmarket sellers · cheapest professional offer · all exact · undercut 2%',
  );
  assert.equal(
    strategySummary({ source: 'cardmarketoffers', basis: 'private', action: 'match', match: { condition: true, language: true, finish: false, firstEdition: false } }),
    'Cardmarket sellers · cheapest private offer · same condition and language · match',
  );
});

test('the display currencies mirror the server and convert at the edge', () => {
  assert.deepEqual(PRICER_CURRENCIES, ['EUR', 'USD', 'GBP', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK', 'CHF', 'HUF', 'RON', 'BGN', 'CAD', 'AUD']);
  assert.deepEqual(currencyContext({ currency: 'EUR' }, null), { code: 'EUR', rate: 1 });
  assert.deepEqual(currencyContext({}, undefined), { code: 'EUR', rate: 1 });
  assert.deepEqual(currencyContext({ currency: 'XXX' }, { rate: 2, day: '2026-11-07' }), { code: 'EUR', rate: 1 }, 'an unknown code reads EUR');
  assert.deepEqual(currencyContext({ currency: 'DKK' }, { rate: 7.46, day: '2026-11-07' }), { code: 'DKK', rate: 7.46 });
  // No fresh rate: EUR, never a wrong number under a DKK label.
  assert.deepEqual(currencyContext({ currency: 'DKK' }, null), { code: 'EUR', rate: 1 });
  assert.deepEqual(currencyContext({ currency: 'GBP' }, { rate: 0, day: '' }), { code: 'EUR', rate: 1 });
  const eur = currencyContext({ currency: 'EUR' });
  assert.equal(pknToLocal(200, eur), 1, 'rate 1: 2 PKN = 1 euro cent');
  assert.equal(localToPkn(1, eur), 200);
  const dkk = currencyContext({ currency: 'DKK' }, { rate: 7.46, day: '2026-11-07' });
  assert.equal(pknToLocal(200, dkk), 7.46);
  for (const value of [0, 1, 25.56, 200, 2642]) {
    assert.ok(Math.abs(localToPkn(pknToLocal(value, dkk), dkk) - value) < 1e-9, `round trip at rate 7.46: ${value}`);
    assert.ok(Math.abs(localToPkn(pknToLocal(value, eur), eur) - value) < 1e-9, `round trip at rate 1: ${value}`);
  }
  assert.equal(formatLocal(pknToLocal(30, eur), eur), '€0.15');
  assert.equal(formatLocal(pknToLocal(200, dkk), dkk), '7.46 DKK');
  assert.equal(formatLocal(pknToLocal(200, { code: 'USD', rate: 1.08 }), { code: 'USD', rate: 1.08 }), '$1.08');
});

test('a summary renders its money in DKK under a DKK context', () => {
  const dkk = currencyContext({ currency: 'DKK' }, { rate: 7.5, day: '2026-11-07' });
  assert.equal(
    strategySummary({ source: 'pokoin', basis: 'sold', action: 'premium', amountPct: 10, amountPkn: 40, minPkn: 200 }, dkk),
    'Pokoin · sold median (90 days) · same condition and language · +10% + 1.50 DKK · min 7.50 DKK',
  );
  assert.equal(
    strategySummary({ source: 'cardtrader', action: 'undercut', amountPct: 5, amountPkn: 40, rounding: 'integer', minPkn: 200 }, dkk),
    'CardTrader · all exact · net of CardTrader fees · undercut 5% − 1.50 DKK · nearest · min 7.50 DKK',
  );
});

test('a strategy name reads in the seller’s currency, never PKN', () => {
  const eur = currencyContext({ currency: 'EUR' });
  const money = (pkn) => formatLocal(pknToLocal(pkn, eur), eur);
  assert.equal(localizeStrategyName('Undercut by 5 PKN', eur), `Undercut by ${money(5)}`);
  assert.equal(localizeStrategyName('Undercut 5PKN', eur), `Undercut ${money(5)}`, 'no space before the unit');
  assert.equal(localizeStrategyName('Undercut 1,000 PKN', eur), `Undercut ${money(1000)}`, 'thousands separator');
  assert.equal(localizeStrategyName('min 1,000.50 PKN', eur), `min ${money(1000.5)}`);
  assert.equal(localizeStrategyName('Above 2.5 pkn', eur), `Above ${money(2.5)}`, 'decimals and any case');
  assert.equal(localizeStrategyName('PKN 5 under', eur), `${money(5)} under`, 'unit before the amount');
  assert.equal(localizeStrategyName('PKN5 under', eur), `${money(5)} under`);
  assert.equal(localizeStrategyName('Undercut 5%', eur), 'Undercut 5%', 'a percent is not money');
  assert.equal(localizeStrategyName('Match CardTrader · same language', eur), 'Match CardTrader · same language', 'nothing to localize');
  assert.equal(localizeStrategyName('Undercut PKN', eur), 'Undercut', 'a bare unit goes with one adjacent space');
  assert.equal(localizeStrategyName('PKN undercut', eur), 'undercut');
  assert.equal(localizeStrategyName('cheap PKN price', eur), 'cheap price');
  assert.equal(localizeStrategyName('', eur), '', 'empty: the caller’s own fallback still applies');
  assert.equal(localizeStrategyName(undefined, eur), '');
  assert.equal(localizeStrategyName('   ', eur), '   ', 'blank stays blank');
  const dkk = currencyContext({ currency: 'DKK' }, { rate: 7.46, day: '2026-11-07' });
  assert.equal(localizeStrategyName('Never below 200 PKN', dkk), `Never below ${formatLocal(pknToLocal(200, dkk), dkk)}`);
  assert.equal(localizeStrategyName('Never below 200 PKN', dkk), 'Never below 7.46 DKK');
  const usd = currencyContext({ currency: 'USD' }, { rate: 1.08, day: '2026-11-07' });
  assert.equal(localizeStrategyName('Undercut by 5 PKN', usd), 'Undercut by $0.03');
  assert.equal(normalizeStrategy({ name: 'Undercut by 5 PKN' }).name, 'Undercut by 5 PKN', 'only the display changes, never the saved name');
});

test('each source has its bases and the toggles it can honour', () => {
  assert.deepEqual(pricerBases('cardmarket').map((b) => b.id), ['trend', 'low', 'avg1', 'avg7', 'avg30']);
  assert.deepEqual(pricerBases('cardmarketoffers').map((b) => b.id), ['pro', 'private']);
  assert.deepEqual(pricerBases('tcgplayer').map((b) => b.id), ['market', 'low', 'mid']);
  assert.deepEqual(pricerBases('nope').map((b) => b.id), ['offers', 'sold']);
  assert.equal(normalizeStrategy({ source: 'cardmarket', basis: 'sold' }).basis, 'trend', 'not a Cardmarket basis: its default');
  assert.equal(normalizeStrategy({ source: 'cardmarketoffers' }).basis, 'pro', 'a professional floor by default');
  assert.equal(normalizeStrategy({ source: 'cardmarketoffers', basis: 'private' }).basis, 'private');
  assert.equal(normalizeStrategy({ source: 'cardmarketoffers', basis: 'trend' }).basis, 'pro', "the guide's columns are not seller types");
  assert.equal(normalizeStrategy({ source: 'CARDMARKETOFFERS', basis: 'PRIVATE' }).source, 'cardmarketoffers');
  assert.equal(normalizeStrategy({ source: 'tcgplayer', basis: 'low' }).basis, 'low');
  assert.equal(normalizeStrategy({ source: 'cardtrader', basis: 'trend' }).basis, 'offers');
  assert.deepEqual(sourceSwitches('tcgplayer', 'market'), { condition: false, language: false, finish: true, firstEdition: true });
  assert.deepEqual(sourceSwitches('pokoin', 'sold'), { condition: true, language: true, finish: false, firstEdition: false });
  assert.deepEqual(sourceSwitches('pokoin', 'offers'), MATCH_ANY);
  assert.deepEqual(sourceSwitches('cardtrader', 'sold'), MATCH_EXACT);
  assert.deepEqual(sourceSwitches('cardmarketoffers', 'pro'), MATCH_EXACT, 'a scanned offer answers all four');
  assert.deepEqual(sourceSwitches('cardmarketoffers', 'private'), MATCH_EXACT);
  assert.deepEqual(effectiveMatch({ source: 'cardmarketoffers' }), MATCH_EXACT);
  assert.deepEqual(
    effectiveMatch({ source: 'tcgplayer', match: { condition: true, language: true, finish: false, firstEdition: true } }),
    { condition: false, language: false, finish: false, firstEdition: true },
  );
  assert.equal(switchNote('cardmarket'), 'Not in Cardmarket’s data');
  assert.equal(sourceHasFees('cardtrader'), true);
  assert.equal(sourceHasFees('tcgplayer'), false);
  assert.equal(sourceHasFees('cardmarketoffers'), false, 'a Cardmarket ask is not a CardTrader fee');
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
