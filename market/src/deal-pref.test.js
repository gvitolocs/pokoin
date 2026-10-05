import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listingLanguageForCountry,
  readDealLanguage,
  resolveDealLanguage,
  writeDealLanguage,
} from './deal-pref.js';

function memoryStorage(seed = {}) {
  const bag = { ...seed };
  return {
    getItem: (key) => (key in bag ? bag[key] : null),
    setItem: (key, value) => { bag[key] = String(value); },
  };
}

test('deal language starts at EN and remembers the account', () => {
  const storage = memoryStorage();
  assert.equal(readDealLanguage('givi', storage), 'EN');
  writeDealLanguage('it', 'givi', storage);
  assert.equal(readDealLanguage('givi', storage), 'IT');
  assert.equal(readDealLanguage('other', storage), 'IT');
  writeDealLanguage('EN', 'other', storage);
  assert.equal(readDealLanguage('givi', storage), 'IT');
  assert.equal(readDealLanguage('other', storage), 'EN');
});

test('a missing language falls back to the account country, not a cheaper grade', () => {
  assert.equal(listingLanguageForCountry('IT'), 'IT');
  assert.equal(listingLanguageForCountry('DK'), '');
  assert.equal(resolveDealLanguage({ selected: 'EN', listed: [] }), 'EN');
  assert.equal(resolveDealLanguage({
    selected: 'EN',
    listed: ['EN', 'IT'],
    country: 'IT',
  }), 'EN');
  assert.equal(resolveDealLanguage({
    selected: 'EN',
    listed: ['IT', 'FR'],
    country: 'IT',
  }), 'IT');
  assert.equal(resolveDealLanguage({
    selected: 'IT',
    listed: ['EN', 'IT'],
    country: 'DK',
  }), 'IT');
  assert.equal(resolveDealLanguage({
    selected: 'EN',
    listed: ['FR'],
    country: 'DK',
  }), 'EN');
});
