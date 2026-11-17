import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRICE_LANGUAGE_FALLBACK,
  SCAN_FALLBACK_PRICE_EUR,
  facetSignature,
  priceFieldCommit,
  scanFacets,
  scanFallbackPricePkn,
  suggestPriceFromSlices,
} from './scan-pricing.js';
import { PKN_USDT_PRICE } from './pkn.js';
import { priceInputFromPkn } from './seller-currency.js';

const slice = (over = {}) => ({
  day: '2026-09-10',
  condition: 'NM',
  language: 'EN',
  reverse: false,
  firstEdition: false,
  graded: false,
  medianPkn: 50,
  sampleCount: 3,
  listings: 3,
  ...over,
});

test('exact facet match wins', () => {
  const slices = [
    slice({ condition: 'PL', language: 'EN', medianPkn: 20 }),
    slice({ condition: 'NM', language: 'JP', medianPkn: 30 }),
    slice({ condition: 'NM', language: 'EN', medianPkn: 50 }),
  ];
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false,
  })), 50);
});

test('relaxes finish and 1st edition before condition', () => {
  const slices = [
    slice({ condition: 'NM', language: 'EN', reverse: true, medianPkn: 33 }),
    slice({ condition: 'PL', language: 'EN', reverse: false, medianPkn: 20 }),
  ];
  // reverse row requested, but only standard slices exist → NM still beats PL
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'EN', foilState: 'reverse', firstEdition: false,
  })), 33);
});

test('nearest condition wins within the same language', () => {
  const slices = [
    slice({ condition: 'PL', language: 'EN', medianPkn: 18 }),
    slice({ condition: 'SP', language: 'EN', medianPkn: 35 }),
    slice({ condition: 'Poor', language: 'EN', medianPkn: 9 }),
  ];
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false,
  })), 35);
});

test('own language at a farther condition wins before language fallback', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'KO', medianPkn: 44 }),
    slice({ language: 'JP', medianPkn: 41 }),
    slice({ condition: 'Poor', language: 'DE', medianPkn: 40 }),
  ], scanFacets({ condition: 'NM', language: 'DE' })), 40);
});

test('European fallback prefers IT over English for a DE card', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ day: '2026-09-10', language: 'IT', medianPkn: 22 }),
    slice({ day: '2026-09-11', language: 'EN', medianPkn: 24 }),
  ], scanFacets({ condition: 'NM', language: 'DE' })), 22);
});

test('exports the fallback language tiers', () => {
  assert.deepEqual(PRICE_LANGUAGE_FALLBACK, [
    ['KO'], ['JP'], ['IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU'], ['EN'], [],
  ]);
});

test('ZH fallback chooses KO SP before JP NM', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'JP', medianPkn: 100 }),
    slice({ language: 'KO', condition: 'SP', medianPkn: 40 }),
  ], scanFacets({ condition: 'NM', language: 'ZH' })), 40);
});

test('ZH fallback chooses JP before EN', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'EN', medianPkn: 100 }),
    slice({ language: 'JP', medianPkn: 60 }),
  ], scanFacets({ condition: 'NM', language: 'ZH' })), 60);
});

test('ZH fallback chooses EN before ZHT', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'ZHT', medianPkn: 100 }),
    slice({ language: 'EN', medianPkn: 60 }),
  ], scanFacets({ condition: 'NM', language: 'ZH' })), 60);
});

test('720186-like ZH NM card with only JP/KO NM comps uses the KO price', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'JP', medianPkn: 720 }),
    slice({ language: 'KO', medianPkn: 366 }),
  ], scanFacets({ cardId: 720186, condition: 'NM', language: 'ZH' })), 366);
});

test('within a language tier nearest condition beats a fresher farther slice', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'IT', condition: 'SP', day: '2026-09-01', medianPkn: 40 }),
    slice({ language: 'FR', condition: 'PL', day: '2026-09-11', medianPkn: 20 }),
  ], scanFacets({ condition: 'NM', language: 'ZH' })), 40);
});

test('within a tier equally near conditions use freshness without language preference', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'IT', day: '2026-09-01', medianPkn: 40 }),
    slice({ language: 'FR', day: '2026-09-11', medianPkn: 50 }),
  ], scanFacets({ condition: 'NM', language: 'ZH' })), 50);
});

test('other and unknown languages remain usable, excluding graded comps', () => {
  assert.equal(suggestPriceFromSlices([
    slice({ language: 'KO', graded: true, medianPkn: 500 }),
    slice({ language: 'TH', condition: 'PL', medianPkn: 40 }),
    slice({ language: '', medianPkn: 20 }),
  ], scanFacets({ condition: 'NM', language: 'ZH' })), 20);
});

test('fresher day and larger sample win ties', () => {
  const slices = [
    slice({ day: '2026-09-01', medianPkn: 10 }),
    slice({ day: '2026-09-10', medianPkn: 12 }),
  ];
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false,
  })), 12);
});

test('graded slices never suggest', () => {
  const slices = [slice({ graded: true, medianPkn: 500 })];
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false,
  })), null);
});

test('no usable slices → null (caller falls back to cheapest listed)', () => {
  assert.equal(suggestPriceFromSlices([], scanFacets({ cardId: 1 })), null);
  assert.equal(suggestPriceFromSlices([slice({ medianPkn: 0 })], scanFacets({ cardId: 1 })), null);
});

test('no comps and no listing → the default is €10,000 in PKN', () => {
  assert.equal(SCAN_FALLBACK_PRICE_EUR, 10000);
  const pkn = scanFallbackPricePkn();
  assert.ok(Number.isInteger(pkn) && pkn > 0, `positive integer, got ${pkn}`);
  // EUR→PKN at the fixed parity: 10,000 / 0.005 = 2,000,000.
  assert.equal(pkn, Math.round(SCAN_FALLBACK_PRICE_EUR / PKN_USDT_PRICE));
  assert.equal(pkn, 2000000);
});

test('facetSignature changes with version and every priced facet', () => {
  const base = { cardId: 7, condition: 'NM', language: 'EN', foilState: 'standard', firstEdition: false };
  const sig = facetSignature(base);
  assert.equal(facetSignature({ ...base }), sig);
  assert.notEqual(facetSignature({ ...base, cardId: 8 }), sig);
  assert.notEqual(facetSignature({ ...base, condition: 'SP' }), sig);
  assert.notEqual(facetSignature({ ...base, language: 'JP' }), sig);
  assert.notEqual(facetSignature({ ...base, foilState: 'reverse' }), sig);
  assert.notEqual(facetSignature({ ...base, firstEdition: true }), sig);
});

test('priceFieldCommit: an emptied field goes back to the default price', () => {
  assert.deepEqual(priceFieldCommit({ pricePkn: 40, priceSuggested: true }, ''), { action: 'default' });
  assert.deepEqual(priceFieldCommit({ pricePkn: 55, priceSuggested: false }, '   '), { action: 'default' });
  assert.deepEqual(priceFieldCommit({ pricePkn: null }, ''), { action: 'default' });
});

test('priceFieldCommit: typed prices save as manual, invalid text restores', () => {
  assert.deepEqual(priceFieldCommit({ pricePkn: 40, priceSuggested: true }, '60'), { action: 'set', pricePkn: 60 });
  // Accepting the suggested value by typing it makes it a manual price.
  assert.deepEqual(priceFieldCommit({ pricePkn: 40, priceSuggested: true }, '40'), { action: 'set', pricePkn: 40 });
  assert.deepEqual(priceFieldCommit({ pricePkn: 40, priceSuggested: false }, ' 40 '), { action: 'keep' });
  assert.deepEqual(priceFieldCommit({ pricePkn: 40 }, 'abc'), { action: 'restore' });
  assert.deepEqual(priceFieldCommit({ pricePkn: 40 }, '0'), { action: 'restore' });
  assert.deepEqual(priceFieldCommit({ pricePkn: 40 }, '-5'), { action: 'restore' });
});

test('priceFieldCommit: sellers type their local currency', () => {
  assert.deepEqual(priceFieldCommit({ pricePkn: null }, '13.21', 'EUR'), { action: 'set', pricePkn: 2642 });
  assert.deepEqual(priceFieldCommit({ pricePkn: 2642, priceSuggested: false }, '13.21', 'EUR'), { action: 'keep' });
  assert.deepEqual(priceFieldCommit({ pricePkn: null }, 'x', 'DKK'), { action: 'restore' });
});

test('tabbing through an untouched fiat price never changes it', () => {
  // 367 PKN is EUR 1.835: the field shows a rounded cent that parses back to 368.
  const row = { pricePkn: 367, priceSuggested: false };
  assert.deepEqual(priceFieldCommit(row, priceInputFromPkn(367, 'EUR'), 'EUR'), { action: 'keep' });
  assert.deepEqual(priceFieldCommit(row, '2', 'EUR'), { action: 'set', pricePkn: 400 });
});
