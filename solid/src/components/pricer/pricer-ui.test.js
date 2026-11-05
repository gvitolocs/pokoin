import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  allSelected,
  appliedLine,
  applyLabel,
  askFor,
  exampleLead,
  exampleSteps,
  groupFilter,
  movePlan,
  moveResultLine,
  NO_GROUP,
  NO_OFFER,
  pickExampleComp,
  pkn,
  planCounts,
  removeResultLine,
  SAMPLE_COMP,
  selectionState,
  selectRows,
  toggleSelected,
  unchangedMembers,
  unchangedMarket,
  uniqueCopyName,
  usedByLine,
} from './pricer-ui.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const rows = (...ids) => ids.map((id) => ({ id }));

test('selection: toggle, page on/off, and the page checkbox state', () => {
  let set = toggleSelected(new Set(), 'a');
  assert.deepEqual([...set], ['a']);
  set = toggleSelected(set, 'a');
  assert.equal(set.size, 0);
  const before = new Set(['x']);
  set = selectRows(before, rows('a', 'b'), true);
  assert.deepEqual([...set].sort(), ['a', 'b', 'x']);
  assert.deepEqual([...before], ['x'], 'never mutates the old set');
  assert.equal(selectionState(set, rows('a', 'b')), 'all');
  assert.equal(selectionState(set, rows('a', 'c')), 'some');
  assert.equal(selectionState(set, rows('c')), 'none');
  assert.equal(selectionState(set, []), 'none');
  set = selectRows(set, rows('a'), false);
  assert.deepEqual([...set].sort(), ['b', 'x']);
});

test('selection survives paging: unselecting one page keeps the others', () => {
  const page1 = rows('a', 'b');
  const page2 = rows('c', 'd');
  let set = selectRows(new Set(), page1, true);
  set = selectRows(set, page2, true);
  set = selectRows(set, page2, false);
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('"Select all filtered" adds every filtered row and hides once all are in', () => {
  const filtered = rows('a', 'b', 'c');
  const set = selectRows(new Set(['z']), filtered, true);
  assert.equal(set.size, 4);
  assert.equal(allSelected(set, filtered), true);
  assert.equal(allSelected(new Set(['a']), filtered), false);
});

test('group filter: any, no group, one group', () => {
  const map = new Map([['a', 'g1'], ['b', 'g2']]);
  const list = rows('a', 'b', 'c');
  assert.deepEqual(list.filter(groupFilter('', map)).map((row) => row.id), ['a', 'b', 'c']);
  assert.deepEqual(list.filter(groupFilter(NO_GROUP, map)).map((row) => row.id), ['c']);
  assert.deepEqual(list.filter(groupFilter('g2', map)).map((row) => row.id), ['b']);
});

test('moving cards says how many came from another group', () => {
  const map = new Map([['a', 'g1'], ['b', 'g2'], ['c', 'g2'], ['d', 'g3']]);
  const groups = [{ id: 'g1', name: 'Bulk' }, { id: 'g2', name: 'Vintage holos' }, { id: 'g3', name: 'Slow movers' }];
  const plan = movePlan(['a', 'b', 'c', 'd', 'e'], map, 'g3');
  assert.deepEqual(plan, { fresh: 1, already: 1, from: [{ groupId: 'g1', count: 1 }, { groupId: 'g2', count: 2 }] });
  assert.equal(
    moveResultLine(plan, groups, 'Slow movers'),
    'Added 4 cards to Slow movers (1 moved from Bulk, 2 moved from Vintage holos, 1 already there).',
  );
  assert.equal(moveResultLine(movePlan(['e'], map, 'g1'), groups, 'Bulk'), 'Added 1 card to Bulk.');
  // A new group: every grouped card is a move.
  assert.equal(moveResultLine(movePlan(['a'], map, ''), groups, 'New'), 'Added 1 card to New (1 moved from Bulk).');
  assert.equal(removeResultLine(2), 'Took 2 cards out of their group.');
  assert.equal(removeResultLine(0), 'None of those cards were in a group.');
});

test('a duplicate gets a unique "copy" name, ignoring case', () => {
  assert.equal(uniqueCopyName('Match CardTrader', [{ name: 'Match CardTrader' }]), 'Match CardTrader copy');
  assert.equal(
    uniqueCopyName('Match CardTrader', [{ name: 'match cardtrader COPY' }, { name: 'Match CardTrader copy 2' }]),
    'Match CardTrader copy 3',
  );
  assert.equal(uniqueCopyName('', []), 'Strategy copy');
  assert.ok(uniqueCopyName('x'.repeat(100), []).length <= 80);
});

test('the example comp is the group\'s first comp with per-toggle offers, else the sample', () => {
  assert.equal(pickExampleComp(null), SAMPLE_COMP);
  const own = { ctMatch: { CLFE: { grossPkn: 460, pkn: 431.94 } } };
  assert.equal(pickExampleComp([null, { ctMatchedPkn: 10 }, own]), own);
  assert.equal(pickExampleComp([{ ctMatchedPkn: 10 }]), SAMPLE_COMP);
  // The sample has an offer for every toggle combination, cheaper as they loosen.
  assert.equal(Object.keys(SAMPLE_COMP.ctMatch).length, 16);
  assert.deepEqual(SAMPLE_COMP.ctMatch.CLFE, { grossPkn: 28, pkn: 25.56 });
  assert.ok(SAMPLE_COMP.ctMatch.CL.grossPkn < SAMPLE_COMP.ctMatch.CLFE.grossPkn);
  assert.ok(SAMPLE_COMP.ctMatch[''].grossPkn < SAMPLE_COMP.ctMatch.CL.grossPkn);
});

test('the worked example walks the mock-up: ask 28 → net 25.56 → −5% 24.28 → nearest 24', () => {
  const exact = { condition: true, language: true, finish: true, firstEdition: true };
  const strategy = { source: 'cardtrader', basis: 'offers', match: exact, feeExclusive: true, action: 'undercut', amountPct: 5, rounding: 'integer', minPkn: 1 };
  assert.deepEqual(exampleSteps(strategy), {
    steps: ['CardTrader ask 28', 'you net 25.56', '−5% 24.28', 'nearest'],
    target: 24,
    noOffer: false,
  });
  assert.deepEqual(exampleSteps({ ...strategy, feeExclusive: false, action: 'match', rounding: 'none' }), {
    steps: ['CardTrader ask 28'],
    target: 28,
    noOffer: false,
  });
  assert.deepEqual(exampleSteps({ source: 'pokoin', basis: 'sold', action: 'premium', amountPct: 10, amountPkn: 2, rounding: 'up' }), {
    steps: ['Pokoin sold median 24.5', '+10% + 2 PKN 28.95', 'round up'],
    target: 29,
    noOffer: false,
  });
  assert.deepEqual(exampleSteps({ source: 'pokoin', basis: 'offers', action: 'match', rounding: 'none' }).steps, ['Pokoin ask 27']);
  assert.equal(exampleLead(['CardTrader ask 28', 'you net 25.56', '−5% 24.28', 'nearest']), 'CardTrader ask 28 → you net 25.56 → −5% 24.28 → nearest ');
  assert.equal(exampleLead(['CardTrader ask 28']), 'CardTrader ask 28 → ');
  // The floor wins and says so.
  const cheap = { ctMatch: { CLFE: { grossPkn: 4, pkn: 3.6 } } };
  assert.deepEqual(exampleSteps({ ...strategy, action: 'undercut', amountPct: 90, minPkn: 5 }, cheap), {
    steps: ['CardTrader ask 4', 'you net 3.6', '−90% 0.36', 'nearest', 'never below 5'],
    target: 5,
    noOffer: false,
  });
});

test('the worked example follows the toggles and says when no offer is like that', () => {
  const comp = { ctMatch: { CLFE: { grossPkn: 460, pkn: 431.94 }, L: { grossPkn: 404.8, pkn: 380.11 } } };
  const base = { source: 'cardtrader', basis: 'offers', feeExclusive: true, action: 'match', rounding: 'none' };
  const exact = exampleSteps({ ...base, match: { condition: true, language: true, finish: true, firstEdition: true } }, comp);
  assert.deepEqual([exact.steps, exact.target], [['CardTrader ask 460', 'you net 431.94'], 431.94]);
  const language = exampleSteps({ ...base, match: { condition: false, language: true, finish: false, firstEdition: false } }, comp);
  assert.deepEqual([language.steps, language.target], [['CardTrader ask 404.8', 'you net 380.11'], 380.11]);
  const none = exampleSteps({ ...base, match: { condition: true, language: false, finish: false, firstEdition: false } }, comp);
  assert.deepEqual(none, { steps: [], target: null, noOffer: true });
  assert.equal(NO_OFFER, 'No offer like that for this card right now');
  assert.equal(askFor(comp, { ...base, match: { condition: false, language: true, finish: false, firstEdition: false } }), 404.8);
  assert.equal(askFor(comp, { ...base, source: 'pokoin' }), null);
});

test('plan counts, the Apply label, unchanged members and the applied line', () => {
  const plan = [
    { listingId: 'a', current: 10, target: 9, activate: false },
    { listingId: 'b', current: 5, target: 5, activate: true },
    { listingId: 'c', current: 0, target: 7, activate: true },
  ];
  assert.deepEqual(planCounts(plan), { prices: 2, onSale: 2 });
  assert.equal(applyLabel(plan), 'Apply 2 prices · put 2 on sale');
  assert.equal(applyLabel(plan.slice(0, 1)), 'Apply 1 price');
  const map = new Map([['a', 'g'], ['d', 'g'], ['e', 'h']]);
  assert.deepEqual(unchangedMembers(rows('a', 'd', 'e'), map, 'g', plan).map((row) => row.id), ['d']);
  assert.equal(appliedLine({ applied: 3, activated: 1, failed: [{ listingId: 'x', error: 'gone' }] }), 'Applied 3 prices · put 1 on sale · 1 failed.');
  assert.equal(appliedLine({ applied: 1, activated: 0, failed: [] }), 'Applied 1 price.');
  assert.equal(usedByLine(['A', 'B']), 'Used by A, B');
  assert.equal(usedByLine([]), 'Not used by any group');
  assert.equal(pkn(2642), '2642 PKN');
  assert.equal(pkn(24.5), '24.50 PKN');
});

test('the board and the Pricer tab share one pricing store from the desk', () => {
  const desk = read('../../pages/Inventory.jsx');
  assert.match(desk, /const pricing = createPricing\(/);
  assert.match(desk, /<PricerTab\s+pricing=\{pricing\}/);
  assert.match(desk, /pricing=\{pricing\}\s+\/>/);
  const board = read('../inventory/InventoryBoard.jsx');
  assert.doesNotMatch(board, /Pricer[D]ialog|Pricer…/);
  assert.match(board, /aria-label="Group"/);
  assert.match(board, /Add to group ▾/);
  const nav = read('../StockNav.jsx');
  assert.match(nav, /label: 'Picked'[^\n]*\n\s*\{ to: '\/mypokoin\/pricer', label: 'Pricer'[^\n]*\n\s*\{ to: '\/mypokoin\/import', label: 'Export'/);
});

test('the preview never calls the pricing API', () => {
  const store = read('./pricing-store.js');
  for (const name of ['saveGroup', 'deleteGroup', 'saveStrategy', 'deleteStrategy', 'apply']) {
    const body = store.slice(store.indexOf(`async function ${name}(`));
    const head = body.slice(0, body.indexOf('const token = await getBearer()'));
    assert.match(head, /if \(preview\) \{[\s\S]*?return/, `${name} answers locally in the preview`);
  }
});

test('a card whose price does not change still shows its comp under the group strategy, and the ask', () => {
  const comp = { ctMatch: { CLFE: { grossPkn: 28, pkn: 25.56 }, '': { grossPkn: 22, pkn: 20.09 } }, soldMedianPkn: 30, soldMedianGrossPkn: 32 };
  const net = { source: 'cardtrader', basis: 'offers', feeExclusive: true };
  assert.deepEqual(unchangedMarket(comp, net), { compPkn: 25.56, askPkn: 28 });
  const any = { condition: false, language: false, finish: false, firstEdition: false };
  assert.deepEqual(unchangedMarket(comp, { ...net, match: any }), { compPkn: 20.09, askPkn: 22 });
  assert.deepEqual(unchangedMarket(comp, { ...net, basis: 'sold' }), { compPkn: 30, askPkn: 32 });
  assert.deepEqual(unchangedMarket(null, net), { compPkn: null, askPkn: null });
  assert.deepEqual(unchangedMarket(comp, null), { compPkn: null, askPkn: null });
});

test('a change hides the old plan in the same flush: the plan is keyed, not cleared by an effect', () => {
  const tab = read('./PricerTab.jsx');
  assert.match(tab, /state && state\.key === planKey\(\) \? state\[field\] : null/);
  assert.doesNotMatch(tab, /setPlan\(null\)/);
});
