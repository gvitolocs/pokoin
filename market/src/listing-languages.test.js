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

test('Riftbound sells the four languages it is printed in, in that order', () => {
  const card = { game: 'riftbound', nationality: 'western' };
  assert.deepEqual(sellLanguages(card), ['EN', 'FR', 'ZH', 'KO']);
  assert.deepEqual(deskLanguageChips(card), ['EN', 'FR', 'ZH', 'KO']);
  assert.equal(deskLanguageChoice(card), 'EN');
});

test('Riftbound ignores the set and release languages that give Pokémon its nine', () => {
  const card = {
    game: 'riftbound',
    nationality: 'western',
    setName: 'Origins',
    releaseLanguages: ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU'],
  };
  assert.deepEqual(sellLanguages(card), ['EN', 'FR', 'ZH', 'KO']);
  assert.deepEqual(deskLanguageChips(card), ['EN', 'FR', 'ZH', 'KO']);
  assert.equal(deskLanguageChoice(card), 'EN');
});

test('a Riftbound desk still offers a language it has data for, after its own', () => {
  // The language of the listing being edited, or of a sale the desk knows of.
  const card = { game: 'riftbound', nationality: 'western', data: ['RU'] };
  assert.deepEqual(deskLanguageChips(card), ['EN', 'FR', 'ZH', 'KO', 'RU']);
  assert.equal(deskLanguageChoice({ ...card, chosen: 'RU' }), 'RU');
  assert.equal(deskLanguageChoice({ ...card, chosen: 'KO' }), 'KO');
  assert.equal(deskLanguageChoice({ ...card, data: ['ZH'], chosen: 'DE' }), 'ZH');
});

test('an Asian Riftbound printing keeps its own nationality rule', () => {
  assert.deepEqual(sellLanguages({ game: 'riftbound', nationality: 'chinese' }), ['ZH', 'ZHT']);
  assert.deepEqual(
    sellLanguages({ game: 'riftbound', nationality: 'korean', setName: 'Origins' }),
    ['JP', 'KO', 'ID', 'TH', 'VI'],
  );
});

test('a Chinese code Riftbound prints is a language, not a redirect', () => {
  const printings = [
    { id: '10', nationality: 'western' },
    { id: '20', nationality: 'chinese', name: 'Kaisa' },
  ];
  assert.deepEqual(versionRedirects(printings, '10', ['EN'], {}).map((row) => row.code), ['ZH', 'ZHT']);
  const codes = versionRedirects(printings, '10', ['EN'], { game: 'riftbound' }).map((row) => row.code);
  assert.equal(codes.includes('ZH'), false);
});

/** Every Pokémon case above: its call and today's result, so the game table cannot move them. */
const POKEMON_LANGS = [
  { fn: 'sell', arg: { nationality: 'western', setName: '151' }, want: ['EN', 'IT', 'FR', 'DE', 'ES', 'PT'] },
  { fn: 'sell', arg: { nationality: 'western', setName: '151', releaseLanguages: ['EN', 'FR'] }, want: ['EN', 'IT', 'FR', 'DE', 'ES', 'PT'] },
  { fn: 'sell', arg: { nationality: 'western', setName: 'Base Set' }, want: ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL'] },
  { fn: 'sell', arg: { nationality: 'western', setName: 'Plasma Blast' }, want: ['EN', 'IT', 'FR', 'DE', 'ES', 'PT'] },
  { fn: 'sell', arg: { nationality: 'japanese', setName: 'Nihil Zero' }, want: ['JP', 'KO', 'ID', 'TH', 'VI'] },
  { fn: 'sell', arg: { nationality: 'korean', setName: '151' }, want: ['JP', 'KO', 'ID', 'TH', 'VI'] },
  { fn: 'sell', arg: { nationality: 'chinese' }, want: ['ZH', 'ZHT'] },
  { fn: 'chips', arg: { nationality: 'chinese' }, want: ['ZH', 'ZHT'] },
  { fn: 'chips', arg: { nationality: 'japanese', setName: 'Nihil Zero' }, want: ['JP', 'KO', 'ID', 'TH', 'VI'] },
  { fn: 'chips', arg: { nationality: 'western', setName: '151' }, want: ['EN', 'IT', 'FR', 'DE', 'ES', 'PT'] },
  { fn: 'chips', arg: { nationality: 'chinese', data: ['EN'] }, want: ['ZH', 'ZHT', 'EN'] },
  { fn: 'choice', arg: { nationality: 'chinese', chosen: 'EN' }, want: 'ZH' },
  { fn: 'choice', arg: { nationality: 'japanese', setName: 'Nihil Zero', chosen: 'EN' }, want: 'JP' },
  { fn: 'choice', arg: { nationality: 'western', setName: '151', chosen: 'EN' }, want: 'EN' },
  { fn: 'choice', arg: { nationality: 'western', setName: '151', chosen: 'IT' }, want: 'IT' },
  { fn: 'choice', arg: { nationality: 'western', setName: '151' }, want: 'EN' },
  { fn: 'choice', arg: { nationality: 'chinese', data: ['ZHT'], chosen: 'EN' }, want: 'ZHT' },
  { fn: 'choice', arg: { nationality: 'chinese', chosen: 'ZHT' }, want: 'ZHT' },
  { fn: 'choice', arg: { nationality: 'chinese', data: ['EN'], chosen: 'EN' }, want: 'EN' },
  { fn: 'choice', arg: { nationality: 'chinese', data: ['ZH'], chosen: 'DE' }, want: 'ZH' },
  { fn: 'choice', arg: { nationality: 'chinese', chosen: 'DE' }, want: 'ZH' },
];

const POKEMON_REDIRECTS = [
  {
    printings: [{ id: '30', nationality: 'chinese', name: 'Talonflame' }],
    currentId: '20',
    listed: ['JP', 'KO', 'ID', 'TH', 'VI'],
    options: { nationality: 'japanese' },
    want: [],
  },
  {
    printings: [{ id: '20', nationality: 'korean', name: 'Magnemite' }],
    currentId: '10',
    listed: ['EN', 'FR'],
    options: {},
    want: ['JP'],
  },
  {
    printings: [
      { id: '10', nationality: 'western' },
      { id: '20', nationality: 'japanese', name: 'Magnemite' },
      { id: '30', nationality: 'chinese' },
    ],
    currentId: '10',
    listed: ['EN', 'FR'],
    options: {},
    want: ['JP', 'ZH', 'ZHT'],
  },
  {
    printings: [{ id: '20', nationality: 'japanese' }],
    currentId: '10',
    listed: ['EN', 'JP'],
    options: {},
    want: [],
  },
];

test('Pokémon lists exactly what it listed before a game table existed', () => {
  const fns = { sell: sellLanguages, chips: deskLanguageChips, choice: deskLanguageChoice };
  for (const { fn, arg, want } of POKEMON_LANGS) {
    const label = `${fn} ${JSON.stringify(arg)}`;
    assert.deepEqual(fns[fn](arg), want, label);
    assert.deepEqual(fns[fn]({ ...arg, game: 'pokemon' }), want, `${label} as pokemon`);
    assert.deepEqual(fns[fn]({ ...arg, game: undefined }), want, `${label} with no game`);
  }
  for (const { printings, currentId, listed, options, want } of POKEMON_REDIRECTS) {
    const label = `redirects ${JSON.stringify(options)}`;
    assert.deepEqual(versionRedirects(printings, currentId, listed, options).map((row) => row.code), want, label);
    assert.deepEqual(
      versionRedirects(printings, currentId, listed, { ...options, game: 'pokemon' }).map((row) => row.code),
      want,
      `${label} as pokemon`,
    );
  }
});
