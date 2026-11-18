import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deskLanguageChips,
  deskLanguageChoice,
  releaseLanguagesForSet,
  sellLanguages,
  versionRedirects,
} from './listing-languages.js';

test('a longer set title still uses the 151 release list', () => {
  assert.deepEqual(releaseLanguagesForSet('Scarlet & Violet 151'), ['EN', 'IT', 'FR', 'DE', 'ES']);
});

test('a western set does not offer Japanese as a listing language', () => {
  const langs = sellLanguages({ nationality: 'western', setName: '151' });
  assert.equal(langs.includes('JP'), false);
  assert.equal(langs.includes('ZH'), false);
  assert.equal(langs.includes('EN'), true);
});

test('database release languages only add NL/PL/RU to the western core', () => {
  assert.deepEqual(
    sellLanguages({ nationality: 'western', setName: '151', releaseLanguages: ['EN', 'FR'] }),
    ['EN', 'IT', 'FR', 'DE', 'ES', 'PT'],
  );
  assert.deepEqual(
    sellLanguages({ nationality: 'western', setName: 'Base Set' }),
    ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL'],
  );
});

test('Plasma Blast lists Spanish and Portuguese though TCGdex lacks them', () => {
  const langs = sellLanguages({ nationality: 'western', setName: 'Plasma Blast' });
  assert.deepEqual(langs, ['EN', 'IT', 'FR', 'DE', 'ES', 'PT']);
});

test('a Japanese printing lists the other Asian languages except Chinese', () => {
  assert.deepEqual(
    sellLanguages({ nationality: 'japanese', setName: 'Nihil Zero' }),
    ['JP', 'KO', 'ID', 'TH', 'VI'],
  );
  const jumps = versionRedirects([
    { id: '30', nationality: 'chinese', name: 'Talonflame' },
  ], '20', ['JP', 'KO', 'ID', 'TH', 'VI'], { nationality: 'japanese' });
  assert.deepEqual(jumps, []);
});

test('a Korean printing is the Japanese version', () => {
  assert.deepEqual(
    sellLanguages({ nationality: 'korean', setName: '151' }),
    ['JP', 'KO', 'ID', 'TH', 'VI'],
  );
  const jumps = versionRedirects([
    { id: '20', nationality: 'korean', name: 'Magnemite' },
  ], '10', ['EN', 'FR']);
  assert.equal(jumps[0].code, 'JP');
  assert.equal(jumps[0].label, 'Japanese');
  assert.equal(jumps[0].card.id, '20');
});

test('selecting JP points at the Japanese artwork sibling', () => {
  const jumps = versionRedirects([
    { id: '10', nationality: 'western' },
    { id: '20', nationality: 'japanese', name: 'Magnemite' },
    { id: '30', nationality: 'chinese' },
  ], '10', ['EN', 'FR']);
  assert.deepEqual(jumps.map((row) => row.code), ['JP', 'ZH', 'ZHT']);
  assert.equal(jumps[0].card.id, '20');
  assert.equal(jumps[0].label, 'Japanese');
  assert.equal(jumps[1].card.id, '30');
});

test('a language the set was released in is not a redirect', () => {
  const jumps = versionRedirects([
    { id: '20', nationality: 'japanese' },
  ], '10', ['EN', 'JP']);
  assert.deepEqual(jumps, []);
});

test('a Chinese printing offers no English to an English reader', () => {
  assert.deepEqual(deskLanguageChips({ nationality: 'chinese' }), ['ZH', 'ZHT']);
  assert.equal(deskLanguageChoice({ nationality: 'chinese', chosen: 'EN' }), 'ZH');
});

test('a Japanese printing offers no English either', () => {
  const chips = deskLanguageChips({ nationality: 'japanese', setName: 'Nihil Zero' });
  assert.equal(chips.includes('EN'), false);
  assert.equal(deskLanguageChoice({ nationality: 'japanese', setName: 'Nihil Zero', chosen: 'EN' }), 'JP');
});

test('a western printing keeps the language the reader prefers', () => {
  const western = { nationality: 'western', setName: '151' };
  assert.equal(deskLanguageChoice({ ...western, chosen: 'EN' }), 'EN');
  assert.equal(deskLanguageChoice({ ...western, chosen: 'IT' }), 'IT');
  assert.equal(deskLanguageChoice(western), 'EN');
});

test('a language with data opens the desk, a preference adds no chip', () => {
  assert.equal(deskLanguageChoice({ nationality: 'chinese', data: ['ZHT'], chosen: 'EN' }), 'ZHT');
  assert.deepEqual(deskLanguageChips({ nationality: 'chinese', data: ['EN'] }), ['ZH', 'ZHT', 'EN']);
});

test('a language asked for is kept only when this printing can exist in it', () => {
  assert.equal(deskLanguageChoice({ nationality: 'chinese', chosen: 'ZHT' }), 'ZHT');
  // The listings say this card does exist in English: the ask is a real chip.
  assert.equal(deskLanguageChoice({ nationality: 'chinese', data: ['EN'], chosen: 'EN' }), 'EN');
  assert.equal(deskLanguageChoice({ nationality: 'chinese', data: ['ZH'], chosen: 'DE' }), 'ZH');
  assert.equal(deskLanguageChoice({ nationality: 'chinese', chosen: 'DE' }), 'ZH');
});
