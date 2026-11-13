import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { claimRows, nextPriceRetry, PRICE_RETRY_MAX, priceKey, releaseUnsettled } from './price-requests.js';

const signatureOf = (row) => `${row.cardId}|${row.language}|${row.condition}`;
const books = () => ({ pricesAsked: new Set(), suggestedFor: new Map(), signatureOf });
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
  const want = rows.filter((row) => row.pricePkn == null && !b.pricesAsked.has(priceKey(row.id, signatureOf(row))));
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
  const failures = new Map();
  const delays = [];
  for (let i = 0; i < PRICE_RETRY_MAX + 2; i += 1) {
    const { retry, delay } = nextPriceRetry(failures, [A], signatureOf);
    delays.push(retry.length ? delay : null);
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, null, null]);
  // Another printing of the same row has its own budget.
  const other = { ...A, language: 'jp' };
  assert.equal(nextPriceRetry(failures, [other], signatureOf).retry.length, 1);
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
