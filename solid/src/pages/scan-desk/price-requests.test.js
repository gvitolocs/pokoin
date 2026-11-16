import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  claimRows,
  dropRows,
  isAskable,
  markSettled,
  nextPriceRetry,
  PRICE_GIVEUP_DELAY,
  PRICE_RETRY_MAX,
  priceKey,
  releaseUnsettled,
} from './price-requests.js';

const signatureOf = (row) => `${row.cardId}|${row.language}|${row.condition}`;
// A clock the tests own: the cool-down is a time, not a counter.
let clock = 0;
const books = () => ({
  pricesAsked: new Set(),
  suggestedFor: new Map(),
  priceFailures: new Map(),
  retryAt: new Map(),
  signatureOf,
  now: () => clock,
});
const A = { id: 'a', cardId: 720186, language: 'zh', condition: 'NM', pricePkn: null };
const B = { id: 'b', cardId: 720186, language: 'zh', condition: 'NM', pricePkn: null };

test('a cancelled run releases only the rows it did not settle', () => {
  const b = books();
  claimRows([A, B], b);
  const released = releaseUnsettled([A, B], new Set(['a']), b);
  assert.deepEqual(released, [B]);
  assert.ok(b.pricesAsked.has(priceKey('a', signatureOf(A))));
  assert.equal(b.suggestedFor.get('a'), signatureOf(A));
  assert.ok(!b.pricesAsked.has(priceKey('b', signatureOf(B))));
  assert.ok(!b.suggestedFor.has('b'));
});

test('a run that settled every row releases nothing', () => {
  const b = books();
  claimRows([A, B], b);
  assert.deepEqual(releaseUnsettled([A, B], new Set(['a', 'b']), b), []);
  assert.equal(b.pricesAsked.size, 2);
  assert.equal(b.suggestedFor.size, 2);
});

test('after the first row is priced, the re-run asks again for the rest of the batch', () => {
  const b = books();
  claimRows([A, B], b);
  // The run prices A; that patch changes the list, the effect re-runs and cancels it.
  const rows = [{ ...A, pricePkn: 720, priceSuggested: true }, B];
  releaseUnsettled([A, B], new Set(['a']), b);
  const want = rows.filter((row) => row.pricePkn == null && isAskable(row, b));
  assert.deepEqual(want.map((row) => row.id), ['b']);
});

test('the Scan Desk prices effect releases unsettled rows on cancel and on failure', () => {
  const scan = fs.readFileSync(new URL('../ScanDesk.jsx', import.meta.url), 'utf8');
  assert.match(scan, /claimRows\(want, books\)/);
  assert.match(scan, /releaseUnsettled\(want, settled, books\)/);
  assert.match(scan, /return \(\) => \{\n\s+cancelled = true;\n\s+release\(\);\n\s+\};/);
  assert.match(scan, /\.catch\(\(\) => \{\n\s+if \(!cancelled\) release\(\);/);
});

test('a failed lookup or save is retried with a backoff, then given up on', () => {
  const b = books();
  const delays = [];
  for (let i = 0; i < PRICE_RETRY_MAX + 2; i += 1) {
    clock += 1000;
    delays.push(nextPriceRetry(b, [A]).delay);
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, PRICE_GIVEUP_DELAY, PRICE_GIVEUP_DELAY]);
  // Another printing of the same row has its own budget.
  const other = { ...A, language: 'jp' };
  assert.equal(nextPriceRetry(b, [other]).retry.length, 1);
});

test('a row that exhausts its retry budget stops being claimed', () => {
  const b = books();
  claimRows([A], b);
  for (let i = 0; i < PRICE_RETRY_MAX; i += 1) {
    clock += 1000;
    assert.equal(nextPriceRetry(b, [A]).retry.length, 1, `attempt ${i + 1} is still under budget`);
    assert.ok(b.pricesAsked.has(priceKey('a', signatureOf(A))), 'a row still being retried stays claimed');
    releaseUnsettled([A], new Set(), b);
    claimRows([A], b);
  }
  clock += 1000;
  const { retry } = nextPriceRetry(b, [A]);
  assert.deepEqual(retry, [], 'the exhausted row is not retried again right away');
  assert.ok(!b.pricesAsked.has(priceKey('a', signatureOf(A))), 'give-up must not leave the row claimed');
  assert.ok(!b.suggestedFor.has('a'));
});

test('a given-up row is released so a later change can ask it again', () => {
  const b = books();
  claimRows([A], b);
  for (let i = 0; i < PRICE_RETRY_MAX; i += 1) nextPriceRetry(b, [A]);
  const { retry, gaveUp, delay } = nextPriceRetry(b, [A]);
  assert.deepEqual(gaveUp, [A], 'the run reports which rows it gave up on');
  assert.equal(retry.length, 0);
  assert.equal(delay, PRICE_GIVEUP_DELAY, 'the desk waits for the cool-down instead of stopping');
  assert.ok(!isAskable(A, b), 'the cool-down keeps it from being asked every keystroke');
  clock += PRICE_GIVEUP_DELAY;
  assert.ok(isAskable(A, b), 'the same mount asks for it again later');
});

test('a save that succeeded settles the row and clears its budget', () => {
  const b = books();
  claimRows([A], b);
  nextPriceRetry(b, [A]);
  assert.equal(markSettled(b, A, true), true);
  assert.ok(!b.pricesAsked.has(priceKey('a', signatureOf(A))));
  assert.equal(b.suggestedFor.get('a'), signatureOf(A));
  assert.equal(b.priceFailures.has(priceKey('a', signatureOf(A))), false, 'no stale budget for a priced row');
});

test('a patch that found no live row releases its claim', () => {
  // `patchRows` answers undefined when the row is gone: that is not a success.
  for (const ok of [undefined, false]) {
    const b = books();
    claimRows([A], b);
    assert.equal(markSettled(b, A, ok), false);
    assert.ok(!b.pricesAsked.has(priceKey('a', signatureOf(A))));
    assert.ok(!b.suggestedFor.has('a'));
  }
});

test('a terminal save error is not retried', () => {
  const b = books();
  claimRows([A], b);
  const { retry, gaveUp, delay } = nextPriceRetry(b, [A], { terminal: true });
  assert.deepEqual(retry, []);
  assert.deepEqual(gaveUp, [A]);
  assert.equal(delay, 0, 'nothing is scheduled for a row that cannot be saved');
  assert.ok(!b.pricesAsked.has(priceKey('a', signatureOf(A))));
  assert.equal(b.priceFailures.size, 0);
  clock += 1;
  assert.ok(isAskable(A, b), 'the row is asked from scratch if it comes back active');
});

test('a row that is gone or not active is dropped without a retry', () => {
  const b = books();
  claimRows([A, B], b);
  nextPriceRetry(b, [A]);
  dropRows(b, [A, B]);
  assert.equal(b.pricesAsked.size, 0);
  assert.equal(b.suggestedFor.size, 0);
  assert.equal(b.priceFailures.size, 0);
  assert.equal(b.retryAt.size, 0);
});

test('a failed read is never taken for "no comps" or "no listing"', () => {
  const scan = fs.readFileSync(new URL('../ScanDesk.jsx', import.meta.url), 'utf8');
  // The slices read is not turned into [] on failure, and a failed one is not cached.
  assert.doesNotMatch(scan, /fetchCardSales\(id, \{ slices: true \}\)[\s\S]{0,160}\.catch\(\(\) => \[\]\)/);
  assert.match(scan, /slicesCache\.delete\(id\)/);
  // The cheapest-price read throws on failure instead of answering "nothing listed".
  assert.match(scan, /fetchCheapestPricePknMap\(\[\.\.\.cheapestIds\], \{ strict: true \}\)/);
  // Failures and rejected saves go back through retryPrices, never to the fallback price.
  assert.match(scan, /retryPrices\(failed\)/);
  assert.match(scan, /if \(ok === false\) retryPrices\(\[row\]\)/);
});

test('invalid text left in the price field of an unpriced or suggested row gives the price back to the default', () => {
  const rows = fs.readFileSync(new URL('./rows.jsx', import.meta.url), 'utf8');
  assert.match(rows, /commit\.action === 'restore' && \(r\.pricePkn == null \|\| r\.priceSuggested\)\)\) props\.onPriceEmptied/);
});
