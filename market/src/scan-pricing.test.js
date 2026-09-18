import assert from 'node:assert/strict';
import test from 'node:test';
import { facetSignature, scanFacets, suggestPriceFromSlices } from './scan-pricing.js';

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

test('falls back to another language only after the condition relaxation', () => {
  const slices = [
    slice({ condition: 'NM', language: 'JP', medianPkn: 44 }),
    slice({ condition: 'NM', language: 'IT', medianPkn: 41 }),
    slice({ condition: 'SP', language: 'EN', medianPkn: 40 }),
  ];
  // No DE data: nearest condition (NM) in another language beats EN in SP.
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'DE', foilState: 'standard', firstEdition: false,
  })), 44);
});

test('same-condition rung prefers English over other languages', () => {
  const slices = [
    slice({ day: '2026-09-11', condition: 'NM', language: 'IT', medianPkn: 22 }),
    slice({ day: '2026-09-10', condition: 'NM', language: 'EN', medianPkn: 24 }),
  ];
  assert.equal(suggestPriceFromSlices(slices, scanFacets({
    cardId: 1, condition: 'NM', language: 'DE', foilState: 'standard', firstEdition: false,
  })), 24);
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
