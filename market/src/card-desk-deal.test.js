import test from 'node:test';
import assert from 'node:assert/strict';
import { bestDealCondition, listedDealConditions, matchDeal, shownDealCondition } from './card-desk.js';

const offer = (id, language, condition, pricePkn) => ({ id, language, condition, pricePkn });
const card = { nationality: 'western' };
const offers = [
  offer('en-nm', 'en', 'Near Mint', 900),
  offer('en-mp', 'en', 'Moderately Played', 300),
  offer('es-mp', 'es', 'Moderately Played', 250),
  offer('es-pl', 'es', 'Played', 120),
  offer('blank-sp', '', 'Slightly Played', 500),
];

test('a language with offers lands on its best listed grade', () => {
  assert.equal(bestDealCondition(offers, 'ES', card), 'MP');
  // NM chosen (default), not listed in Spanish: show MP instead of an empty deal.
  assert.equal(shownDealCondition(offers, 'ES', 'NM', card), 'MP');
  assert.equal(matchDeal(offers, 'ES', shownDealCondition(offers, 'ES', 'NM', card), card)?.id, 'es-mp');
  // A chosen grade that is listed in that language stays.
  assert.equal(shownDealCondition(offers, 'ES', 'PL', card), 'PL');
  // A language with no offers keeps the wanted grade (nothing better to show).
  assert.equal(shownDealCondition(offers, 'DE', 'NM', card), 'NM');
  assert.equal(bestDealCondition(offers, 'DE', card), '');
});

test('the deal matches languages the way the chips list them', () => {
  // Empty CardTrader language = the print language (EN for a western card).
  assert.equal(matchDeal(offers, 'EN', 'SP', card)?.id, 'blank-sp');
  assert.equal(matchDeal([offer('ja', 'ja', 'Near Mint', 10)], 'JP', 'NM', { nationality: 'japanese' })?.id, 'ja');
});

test('condition chips grey out per language', () => {
  assert.deepEqual(listedDealConditions(offers, 'ES', card).map((row) => row.value), ['PL', 'MP']);
  assert.deepEqual(listedDealConditions(offers).map((row) => row.value).sort(), ['MP', 'NM', 'PL', 'SP'].sort());
});
