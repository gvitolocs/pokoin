import assert from 'node:assert/strict';
import test from 'node:test';
// Relative, not @market: node --test loads these without Vite's alias.
import { facetSignature, scanFallbackPricePkn } from '../../../../market/src/scan-pricing.js';
import { claimRows, isAskable, priceKey } from './price-requests.js';
import {
  priceFieldBlur,
  rowNeedsPrice,
  selectPriceRows,
  startPriceRun,
  staleSuggestion,
  suggestionPatch,
} from './price-run.js';

const EN = { condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false, status: 'active' };
const row = (id, cardId, extra = {}) => ({ id, cardId, ...EN, pricePkn: null, priceSuggested: false, ...extra });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise((done) => setTimeout(done, 0));

/**
 * The desk the run talks to: a row store, the two price reads, the save, the
 * retry queue and the default-price book — each one scripted per test.
 */
function harness(sourceRows, { slices, cheapest, save } = {}) {
  const store = new Map(sourceRows.map((r) => [r.id, { ...r }]));
  const books = {
    pricesAsked: new Set(),
    suggestedFor: new Map(),
    priceFailures: new Map(),
    retryAt: new Map(),
    signatureOf: facetSignature,
    now: () => 0,
  };
  const touched = new Map();
  const saves = [];
  const retried = [];
  const remembered = new Map();
  const deps = {
    books,
    touched,
    liveRow: (id) => store.get(id),
    loadSlices: async (cardId) => (slices ? slices(String(cardId)) : { ok: true, slices: [] }),
    loadCheapest: async (ids) => (cheapest ? cheapest(ids.map(String)) : {}),
    save: (r, patch) => {
      saves.push({ id: r.id, patch });
      return save ? save(r, patch) : Promise.resolve(true);
    },
    retry: (failed) => retried.push(...failed.map((r) => r.id)),
    rememberDefault: (id, signature, pkn) => remembered.set(id, { signature, pkn }),
  };
  return {
    books,
    touched,
    deps,
    saves,
    retried,
    remembered,
    set: (id, changes) => store.set(id, { ...(store.get(id) || {}), ...changes }),
    ask: () => [...store.values()],
    run: (rows) => startPriceRun(selectPriceRows(rows, { books, touched }), deps),
  };
}

const withComps = (pkn) => ({
  ok: true,
  slices: [{ day: '2026-11-01', sampleCount: 5, condition: 'NM', language: 'EN', medianPkn: pkn }],
});

test('a row with no sold comps gets the cheapest listed price', async () => {
  const desk = harness([row('r1', 100)], {
    slices: () => ({ ok: true, slices: [] }),
    cheapest: () => ({ 100: 720 }),
  });
  await desk.run(desk.ask());
  assert.deepEqual(desk.saves, [{ id: 'r1', patch: { pricePkn: 720, priceSuggested: true, onlyIfEmptyPrice: true } }]);
  assert.deepEqual(desk.remembered.get('r1'), { signature: facetSignature(row('r1', 100)), pkn: 720 });
});

test('a no-comp row survives a new scan while its fallback request is in flight', async () => {
  const cheap = deferred();
  let cheapestCalls = 0;
  const desk = harness([row('r1', 100), row('r2', 200)], {
    slices: (id) => (id === '100' ? withComps(300) : { ok: true, slices: [] }),
    // The no-comp printing asks once; the answer is held until the test lets it land.
    cheapest: () => {
      cheapestCalls += 1;
      return cheapestCalls === 1 ? cheap.promise : {};
    },
  });
  const first = desk.run([desk.deps.liveRow('r1'), desk.deps.liveRow('r2')]);
  await tick();
  // The phone scans a third card: that must not preempt the fallback in flight.
  desk.set('r3', row('r3', 300));
  const second = desk.run([desk.deps.liveRow('r3')]);
  assert.equal(isAskable(row('r2', 200), desk.books), false, 'r2 stays claimed by its own run');
  cheap.resolve({});
  await Promise.all([first, second]);
  const r2 = desk.saves.filter((s) => s.id === 'r2');
  assert.equal(r2.length, 1, 'r2 is priced exactly once, by the run that claimed it');
  assert.equal(r2[0].patch.pricePkn, scanFallbackPricePkn(), 'and from the documented last rung');
  assert.deepEqual(desk.saves.filter((s) => s.id === 'r1').map((s) => s.patch.pricePkn), [300]);
  assert.deepEqual(desk.saves.filter((s) => s.id === 'r3').map((s) => s.patch.pricePkn), [scanFallbackPricePkn()]);
  assert.equal(cheapestCalls, 2, 'the new scan reads its own printing, never r2 again');
});

test('a lookup whose row changed printing writes nothing', async () => {
  const comps = deferred();
  const desk = harness([row('r1', 100)], { slices: () => comps.promise });
  const claim = desk.deps.liveRow('r1');
  const running = desk.run([claim]);
  await tick();
  // onPick → the row is another printing now, and the server cleared its price.
  desk.set('r1', { cardId: 200, pricePkn: null, priceSuggested: false });
  comps.resolve(withComps(300));
  await running;
  assert.deepEqual(desk.saves, [], 'P1’s suggestion never lands on P2');
  assert.deepEqual(desk.retried, [], 'the newer claim of P2 is not disturbed');
  assert.equal(desk.books.suggestedFor.get('r1'), undefined);
  assert.equal(isAskable(row('r1', 100), desk.books), true, 'the old claim is released, not left behind');
});

test('a lookup for a row that stopped being active is dropped quietly', async () => {
  const comps = deferred();
  const desk = harness([row('r1', 100)], { slices: () => comps.promise });
  const running = desk.run(desk.ask());
  await tick();
  desk.set('r1', { status: 'cancelled' });
  comps.resolve(withComps(300));
  await running;
  assert.deepEqual(desk.saves, []);
  assert.deepEqual(desk.retried, [], 'a row the desk does not own is not retried');
  assert.equal(desk.books.priceFailures.size, 0);
  assert.equal(desk.books.pricesAsked.size, 0);
});

test('a quantity change while the lookup runs is not a new shape', async () => {
  const comps = deferred();
  const desk = harness([row('r1', 100)], { slices: () => comps.promise });
  const running = desk.run(desk.ask());
  await tick();
  desk.set('r1', { quantity: 4 });
  comps.resolve(withComps(300));
  await running;
  assert.deepEqual(desk.saves.map((s) => s.patch.pricePkn), [300]);
});

test('a failed cheapest-price read still prices the row from the fallback', async () => {
  const desk = harness([row('r1', 100)], {
    slices: () => ({ ok: true, slices: [] }),
    cheapest: () => { throw new Error('502'); },
  });
  await desk.run(desk.ask());
  assert.deepEqual(desk.saves.map((s) => s.patch.pricePkn), [scanFallbackPricePkn()]);
  assert.deepEqual(desk.retried, [], 'the row has a price: nothing is left asking');
});

test('a failed comps read asks again instead of pricing from nothing', async () => {
  const desk = harness([row('r1', 100)], { slices: () => ({ ok: false, slices: [] }) });
  await desk.run(desk.ask());
  assert.deepEqual(desk.saves, []);
  assert.deepEqual(desk.retried, ['r1']);
  assert.equal(isAskable(row('r1', 100), desk.books), true, 'released for the retry');
});

test('one row’s failing read does not price or strand the others', async () => {
  const desk = harness([row('r1', 100), row('r2', 200), row('r3', 300)], {
    slices: (id) => (id === '200' ? { ok: false, slices: [] } : id === '100' ? withComps(300) : { ok: true, slices: [] }),
    cheapest: (ids) => (ids.includes('300') ? { 300: 410 } : {}),
  });
  await desk.run(desk.ask());
  const byId = Object.fromEntries(desk.saves.map((s) => [s.id, s.patch.pricePkn]));
  assert.deepEqual(byId, { r1: 300, r3: 410 });
  assert.deepEqual(desk.retried, ['r2']);
});

test('a row is settled only once its save succeeded', async () => {
  const save = deferred();
  const desk = harness([row('r1', 100)], { slices: () => withComps(300), save: () => save.promise });
  const running = desk.run(desk.ask());
  await tick();
  assert.equal(isAskable(row('r1', 100), desk.books), false, 'still claimed while the save is in flight');
  assert.equal(desk.remembered.size, 0, 'no default price is remembered for a save that has not landed');
  save.resolve(true);
  await running;
  assert.equal(desk.books.pricesAsked.size, 0);
  assert.deepEqual(desk.remembered.get('r1'), { signature: facetSignature(row('r1', 100)), pkn: 300 });
});

test('a rejected save releases the row and asks again', async () => {
  const desk = harness([row('r1', 100)], { slices: () => withComps(300), save: () => Promise.resolve(false) });
  await desk.run(desk.ask());
  assert.deepEqual(desk.retried, ['r1']);
  assert.equal(isAskable(row('r1', 100), desk.books), true);
  assert.equal(desk.remembered.size, 0, 'a price the server refused is not the row’s default price');
});

test('a save that found no live row releases its claim', async () => {
  const desk = harness([row('r1', 100)], { slices: () => withComps(300), save: () => Promise.resolve(undefined) });
  await desk.run(desk.ask());
  assert.equal(desk.books.pricesAsked.size, 0, 'undefined is not a success');
  assert.deepEqual(desk.retried, ['r1']);
});

test('a save refused on a row the desk no longer owns is not retried', async () => {
  const desk = harness([row('r1', 100)], {
    slices: () => withComps(300),
    save: () => {
      desk.set('r1', { status: 'cancelled' });
      return Promise.resolve(false);
    },
  });
  await desk.run(desk.ask());
  assert.deepEqual(desk.retried, []);
  assert.equal(desk.books.pricesAsked.size, 0);
});

test('a manual price typed while the lookup ran wins', async () => {
  const comps = deferred();
  const desk = harness([row('r1', 100)], { slices: () => comps.promise });
  const running = desk.run(desk.ask());
  await tick();
  desk.set('r1', { pricePkn: 500, priceSuggested: false });
  comps.resolve(withComps(300));
  await running;
  assert.deepEqual(desk.saves, [], 'the pipeline never overwrites the seller’s number');
  assert.deepEqual(desk.retried, []);
  assert.equal(desk.books.pricesAsked.size, 0);
});

test('a suggestion already stored for the same price is not saved again', async () => {
  const desk = harness([row('r1', 100, { pricePkn: 300, priceSuggested: true })], { slices: () => withComps(300) });
  await desk.run([desk.deps.liveRow('r1')]);
  assert.deepEqual(desk.saves, []);
  assert.deepEqual(desk.remembered.get('r1'), { signature: facetSignature(row('r1', 100)), pkn: 300 });
});

test('the cheapest read covers each printing once per run', async () => {
  const asked = [];
  const desk = harness([row('r1', 100), row('r2', 100), row('r3', 200)], {
    slices: () => ({ ok: true, slices: [] }),
    cheapest: (ids) => {
      asked.push(ids);
      return { 100: 720, 200: 60 };
    },
  });
  await desk.run(desk.ask());
  assert.deepEqual(asked, [['100', '200']], 'one batched call, one entry per printing');
  assert.deepEqual(Object.fromEntries(desk.saves.map((s) => [s.id, s.patch.pricePkn])), { r1: 720, r2: 720, r3: 60 });
});

test('staleSuggestion separates printings and facets from incidental edits', () => {
  const claimed = row('r1', 100);
  assert.equal(staleSuggestion(claimed, { ...claimed, cardId: 200 }), true);
  assert.equal(staleSuggestion(claimed, { ...claimed, condition: 'SP' }), true);
  assert.equal(staleSuggestion(claimed, { ...claimed, language: 'JP' }), true);
  assert.equal(staleSuggestion(claimed, { ...claimed, firstEdition: true }), true);
  assert.equal(staleSuggestion(claimed, { ...claimed, foilState: 'reverse' }), true);
  assert.equal(staleSuggestion(claimed, { ...claimed, quantity: 9 }), false);
  assert.equal(staleSuggestion(claimed, { ...claimed, location: 'BOX A' }), false);
  assert.equal(staleSuggestion(claimed, { ...claimed, status: 'paused' }), true);
  assert.equal(staleSuggestion(claimed, undefined), true);
});

test('the patch only fills a price that is still empty', () => {
  assert.deepEqual(suggestionPatch(row('r1', 100), 320.4), { pricePkn: 320, priceSuggested: true, onlyIfEmptyPrice: true });
  const stale = row('r1', 100, { pricePkn: 999, priceSuggested: true });
  assert.deepEqual(suggestionPatch(stale, 320), { pricePkn: 320, priceSuggested: true }, 'an old suggestion is replaced, not guarded');
});

test('clicking into the price box only owns that shape', () => {
  const desk = harness([row('r1', 100)]);
  const current = desk.deps.liveRow('r1');
  assert.equal(rowNeedsPrice(current, { books: desk.books, touched: desk.touched }), true);
  desk.touched.set('r1', facetSignature(current));
  assert.equal(rowNeedsPrice(current, { books: desk.books, touched: desk.touched }), false, 'this shape is the seller’s');
  const other = { ...current, cardId: 200 };
  assert.equal(rowNeedsPrice(other, { books: desk.books, touched: desk.touched }), true, 'another printing is new intent');
  const facet = { ...current, condition: 'SP' };
  assert.equal(rowNeedsPrice(facet, { books: desk.books, touched: desk.touched }), true, 'a facet change is new intent');
});

test('a row is asked once, and a given-up row waits for its cool-down', () => {
  let clock = 0;
  const desk = harness([row('r1', 100)]);
  desk.books.now = () => clock;
  const rows = desk.ask();
  claimRows(rows, desk.books);
  assert.deepEqual(selectPriceRows(rows, { books: desk.books, touched: desk.touched }), [], 'an in-flight row is not claimed twice');
  const key = priceKey('r1', facetSignature(rows[0]));
  desk.books.retryAt.set(key, 60000);
  desk.books.pricesAsked.delete(key);
  assert.deepEqual(selectPriceRows(rows, { books: desk.books, touched: desk.touched }), [], 'the cool-down keeps it quiet');
  clock = 60000;
  assert.deepEqual(selectPriceRows(rows, { books: desk.books, touched: desk.touched }).map((r) => r.id), ['r1'], 'the same mount asks again later');
});

test('a suggested row is re-priced only when its shape changed', () => {
  const desk = harness([]);
  const priced = row('r1', 100, { pricePkn: 300, priceSuggested: true });
  desk.books.suggestedFor.set('r1', facetSignature(priced));
  assert.equal(rowNeedsPrice(priced, { books: desk.books, touched: desk.touched }), false, 'asked for this shape already');
  assert.equal(rowNeedsPrice({ ...priced, language: 'JP' }, { books: desk.books, touched: desk.touched }), true);
  const manual = row('r2', 100, { pricePkn: 300, priceSuggested: false });
  desk.books.suggestedFor.set('r2', 'other');
  assert.equal(rowNeedsPrice(manual, { books: desk.books, touched: desk.touched }), false, 'a manual price is never re-suggested');
});

test('blurring a price field nobody typed in keeps the suggestion', () => {
  const suggested = row('r1', 100, { pricePkn: 320, priceSuggested: true });
  assert.equal(priceFieldBlur(suggested, '320', 'PKN', false).action, 'default', 'the field refilled itself: still a suggestion');
  assert.equal(priceFieldBlur(suggested, '', 'PKN', false).action, 'default');
  assert.equal(priceFieldBlur(suggested, '321', 'PKN', true).action, 'set', 'a different number is a manual price');
  assert.equal(priceFieldBlur(suggested, '320', 'PKN', true).action, 'keep', 're-typing the suggestion unchanged is not');
  assert.equal(priceFieldBlur(suggested, 'abc', 'PKN', true).action, 'restore');
  const manual = row('r1', 100, { pricePkn: 500, priceSuggested: false });
  assert.equal(priceFieldBlur(manual, '', 'PKN', true).action, 'default', 'clearing a manual price gives the default back');
  assert.equal(priceFieldBlur(manual, '500', 'PKN', false).action, 'keep');
  assert.equal(priceFieldBlur(manual, '501', 'PKN', true).action, 'set');
  const unpriced = row('r1', 100);
  assert.equal(priceFieldBlur(unpriced, 'abc', 'PKN', true).action, 'restore');
});
