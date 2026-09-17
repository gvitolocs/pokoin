import assert from 'node:assert/strict';
import test from 'node:test';
import { filterExpansionCards, filterSearchCards, uniqueSearchOptions, searchPrintLang, searchRarity, searchSet, isLegendCard, legendVersionPairKey, legendHalfOrder } from './search-filters.js';

const mimikyu = {
  name: 'Mimikyu',
  set: 'Paldean Fates',
  rarity: 'Illustration Rare',
  productType: 'card',
  price: 120,
};
const box = {
  name: 'Paldean Fates Elite Trainer Box',
  set: 'Paldean Fates',
  rarity: '',
  productType: 'booster_box',
  price: 800,
};
const charizard = {
  name: 'Charizard',
  set: 'Obsidian Flames',
  number: 'Special Illustration Rare | 234/197',
  productType: 'card',
  price: 400,
};

test('search options list unique rarities and sets', () => {
  assert.deepEqual(uniqueSearchOptions([mimikyu, charizard, box], searchRarity), [
    'Illustration Rare',
    'Special Illustration Rare',
  ]);
  assert.deepEqual(uniqueSearchOptions([mimikyu, charizard, box], searchSet), [
    'Obsidian Flames',
    'Paldean Fates',
  ]);
});

test('search filters drop sealed products and sort by price', () => {
  const shown = filterSearchCards([box, mimikyu, charizard], {
    type: 'singles',
    sort: 'price-asc',
  });
  assert.deepEqual(shown.map((row) => row.name), ['Mimikyu', 'Charizard']);
});

test('singles filters drop theme decks even when catalogued as cards', () => {
  const deck = {
    name: 'Arceus: Flamemaster Theme Deck',
    set: 'HeartGold & SoulSilver Platinum',
    productType: 'card',
    price: 50,
  };
  const shown = filterSearchCards([deck, mimikyu], { type: 'singles' });
  assert.deepEqual(shown.map((row) => row.name), ['Mimikyu']);
});

test('search filters match a name query against set and collector number', () => {
  const shown = filterSearchCards([mimikyu, charizard, box], { query: 'obsidian' });
  assert.deepEqual(shown.map((row) => row.name), ['Charizard']);
  assert.equal(filterSearchCards([mimikyu, charizard], { query: '234' })[0].name, 'Charizard');
});

test('artist desk print chip keeps western cards by default', () => {
  const rows = [
    { name: 'Jolteon', nationality: 'western' },
    { name: 'Pikachu', nationality: 'japanese' },
    { name: 'Espurr', nationality: 'chinese' },
    { name: 'Charmander', nationality: 'korean' },
    { name: 'Ponyta', nationality: 'indonesian' },
  ];
  assert.deepEqual(
    filterSearchCards(rows, { print: 'western' }).map((row) => row.name),
    ['Jolteon'],
  );
  assert.deepEqual(
    filterSearchCards(rows, { print: 'japanese' }).map((row) => row.name),
    ['Pikachu', 'Charmander'],
  );
  assert.deepEqual(
    filterSearchCards(rows, { print: 'chinese' }).map((row) => row.name),
    ['Espurr'],
  );
  assert.deepEqual(
    filterSearchCards(rows, { print: 'indonesian' }).map((row) => row.name),
    ['Ponyta'],
  );
});

test('search filters match rarity and set together', () => {
  const shown = filterSearchCards([mimikyu, charizard, box], {
    rarity: 'Illustration Rare',
    set: 'Paldean Fates',
  });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].name, 'Mimikyu');
});

test('set browse searches collector numbers, reverse, and listed PKN', () => {
  const giratina = {
    name: 'Giratina',
    number: '113/101',
    rarity: 'Illustration Rare',
    nationality: 'western',
    price: 90,
  };
  const reverse = {
    name: 'Oricorio',
    number: 'Reverse Holo | 12/101',
    rarity: 'Common',
    nationality: 'japanese',
  };
  const first = {
    name: 'Base Charizard',
    number: '1st Edition | 4/102',
    rarity: 'Holo Rare',
    nationality: 'western',
    price: 12,
  };
  const numbered = filterExpansionCards([giratina, reverse, first], { query: '113', sort: 'number' });
  assert.deepEqual(numbered.map((row) => row.name), ['Giratina']);
  const byNumber = filterExpansionCards([giratina, reverse, first], { sort: 'number' });
  assert.deepEqual(byNumber.map((row) => row.name), ['Base Charizard', 'Oricorio', 'Giratina']);
  const byName = filterExpansionCards([giratina, reverse, first], { sort: 'name' });
  assert.equal(byName[0].name, 'Base Charizard');
  assert.equal(filterExpansionCards([giratina, reverse, first], { reverse: 'yes' }).length, 1);
  assert.equal(filterExpansionCards([giratina, reverse, first], { firstEdition: 'yes' })[0].name, 'Base Charizard');
  assert.deepEqual(
    filterExpansionCards([giratina, reverse, first], { listed: 'yes' }).map((row) => row.name),
    ['Base Charizard', 'Giratina'],
  );
  assert.deepEqual(uniqueSearchOptions([giratina, reverse, first], searchPrintLang), ['EN', 'JP']);
  assert.equal(filterExpansionCards([giratina, reverse, first], { language: 'JP' })[0].name, 'Oricorio');
  assert.equal(
    filterExpansionCards(
      [{ name: 'Combee', number: '6/76' }],
      { language: 'JP', fallbackLang: 'JP' },
    )[0].name,
    'Combee',
  );
});

test('set desk drops merch backpacks and keeps Nemona Backpack', () => {
  const shown = filterExpansionCards([
    {
      id: '1',
      name: 'International Championship 2024 | Pokémon Center Backpack',
      number: 'Europe',
    },
    {
      id: '2',
      name: "Nemona's Backpack",
      number: '083/091',
    },
  ], { sort: 'number' });
  assert.deepEqual(shown.map((card) => card.name), ["Nemona's Backpack"]);
});

test('set desk drops boxes frames and markers, keeps energy and numbered cards', () => {
  const shown = filterExpansionCards([
    { id: '1', name: 'Zacian V', number: '161/103', set: '30th Celebration JP' },
    { id: '2', name: '30th Celebration JP | Burned Condition Marker', number: '', set: '30th Celebration JP' },
    { id: '3', name: '30th Celebration JP Display Frame', set: '30th Celebration JP' },
    { id: '4', name: '30th Celebration JP Futuristic Box', set: '30th Celebration JP' },
    { id: '5', name: '30th Celebration JP Long Card Box', set: '30th Celebration JP' },
    {
      id: '6',
      name: '30th Celebration Simplified Chinese | Espeon & Umbreon Metal Storage Box',
      number: 'Premium Deck Set',
      set: '30th Celebration JP',
    },
    { id: '7', name: 'Basic Fire Energy', number: '412506', set: '30th Celebration JP' },
    { id: '8', name: 'Secret Box', number: '163/159', set: 'Crown Zenith' },
  ], { sort: 'number' });
  assert.deepEqual(shown.map((card) => card.name), ['Zacian V', 'Secret Box', 'Basic Fire Energy']);
});

test('Holiday Calendar set desk excludes sealed calendars and inserts', () => {
  const shown = filterExpansionCards([
    { id: '1', name: 'Pikachu', number: '025', set: 'Holiday Calendar' },
    { id: '2', name: 'Pokémon TCG: Holiday Calendar 2024', set: 'Holiday Calendar' },
    { id: '3', name: 'Holiday Calendar 2023 Sticker Sheet', set: 'Holiday Calendar' },
    { id: '4', name: 'Holiday Calendar 2022 Keychain', number: 'Deliberd', set: 'Holiday Calendar' },
  ], { sort: 'number' });
  assert.deepEqual(shown.map((card) => card.name), ['Pikachu']);
});

test('set number sort keeps AR/SH letter codes after n/m, not mixed into 1–9', () => {
  const shown = filterExpansionCards([
    { id: 'ar1', name: 'Arceus Lv.100', number: 'Holo Rare | AR1', productType: 'card' },
    { id: 'c1', name: 'Charizard', number: 'Holo Rare | 001/099', productType: 'card' },
    { id: 'c9', name: 'Swalot', number: 'Holo Rare | 009/099', productType: 'card' },
    { id: 'sh10', name: 'Bagon', number: 'SH10 | Holo Rare', productType: 'card' },
  ], { sort: 'number' });
  assert.deepEqual(shown.map((card) => card.id), ['c1', 'c9', 'ar1', 'sh10']);
  assert.deepEqual(
    uniqueSearchOptions([
      { name: 'Bagon', number: 'SH10 | Holo Rare', rarity: 'Card', productType: 'card' },
      { name: 'Charizard', number: 'Holo Rare | 001/099', rarity: 'Card', productType: 'card' },
    ], searchRarity),
    ['Holo Rare'],
  );
});


test('LEGEND version pair key collapses consecutive half public ids', () => {
  assert.equal(legendVersionPairKey({ version: 'v263304' }), 'v263304');
  assert.equal(legendVersionPairKey({ version: 'v263306' }), 'v263304');
  assert.equal(legendVersionPairKey({ version: 'v263312' }), 'v263312');
  assert.equal(legendVersionPairKey({ version: 'v263314' }), 'v263312');
  assert.equal(isLegendCard({ name: 'Entei & Raikou Legend' }), true);
  assert.equal(isLegendCard({ name: 'Call of Legends Booster' }), false);
  assert.equal(legendHalfOrder({ name: 'Entei & Raikou Legend', rarity: 'Top', number: '90/95' }), 0);
  assert.equal(legendHalfOrder({ name: 'Entei & Raikou Legend', rarity: 'Bottom', number: '91/95' }), 1);
  assert.equal(legendHalfOrder({ name: 'Suicune & Entei LEGEND', rarity: 'WCD 2011', version: 'v263312' }), 0);
  assert.equal(legendHalfOrder({ name: 'Suicune & Entei LEGEND', rarity: 'WCD 2011', version: 'v263314' }), 1);
});

test('Pokédex sort keeps LEGEND Top immediately before matching Bottom', () => {
  const top = {
    id: '263312',
    name: 'Suicune & Entei Legend',
    set: 'Unleashed',
    number: 'Top | 94/95',
    rarity: 'Top',
    version: 'v263312',
    pokedexSort: 245080001,
    expansionSort: 80001,
    collectorSort: 94,
    nationality: 'western',
    productType: 'card',
  };
  const bottom = {
    id: '263314',
    name: 'Suicune & Entei Legend',
    set: 'Unleashed',
    number: 'Bottom | 95/95',
    rarity: 'Bottom',
    version: 'v263314',
    pokedexSort: 245080001,
    expansionSort: 80001,
    collectorSort: 95,
    nationality: 'western',
    productType: 'card',
  };
  const wcdTop = {
    id: '650874',
    name: 'Suicune & Entei LEGEND',
    set: 'World Championships 2011',
    number: 'WCD 2011',
    rarity: 'WCD 2011',
    version: 'v263312',
    pokedexSort: 245080001,
    expansionSort: 105000,
    collectorSort: 152011,
    nationality: 'western',
    productType: 'card',
  };
  const wcdBottom = {
    id: '650876',
    name: 'Suicune & Entei LEGEND',
    set: 'World Championships 2011',
    number: 'WCD 2011',
    rarity: 'WCD 2011',
    version: 'v263314',
    pokedexSort: 245080001,
    expansionSort: 105000,
    collectorSort: 152011,
    nationality: 'western',
    productType: 'card',
  };
  const enteiTop = {
    id: '263304',
    name: 'Entei & Raikou Legend',
    set: 'Unleashed',
    number: 'Top | 90/95',
    rarity: 'Top',
    version: 'v263304',
    pokedexSort: 244080001,
    expansionSort: 80001,
    collectorSort: 90,
    nationality: 'western',
    productType: 'card',
  };
  const enteiBottom = {
    id: '263306',
    name: 'Entei & Raikou Legend',
    set: 'Unleashed',
    number: 'Bottom | 91/95',
    rarity: 'Bottom',
    version: 'v263306',
    pokedexSort: 244080001,
    expansionSort: 80001,
    collectorSort: 91,
    nationality: 'western',
    productType: 'card',
  };
  // Shuffle so version-key order would previously insert WCD between halves.
  const shown = filterSearchCards(
    [wcdBottom, bottom, wcdTop, enteiBottom, top, enteiTop],
    { sort: 'pokedex', expandPokedexPairs: true },
  );
  assert.deepEqual(
    shown.map((row) => `${row.id}:${row.rarity}`),
    [
      '263304:Top',
      '263306:Bottom',
      '263312:Top',
      '263314:Bottom',
      '650874:WCD 2011',
      '650876:WCD 2011',
    ],
  );
});

test('Pokédex LEGEND pairing leaves Tag Team expand and non-LEGEND order intact', () => {
  const charizard = {
    id: 'ch',
    name: 'Charizard',
    set: 'Base Set',
    number: '4/102',
    pokedexSort: 6_000_000 + 10_000,
    productType: 'card',
  };
  const team = {
    id: 'cb',
    name: 'Charizard & Braixen GX',
    set: 'Cosmic Eclipse',
    number: 'Full-Art | 22/236',
    pokedexSort: 6_000_000 + 140_000,
    productType: 'card',
  };
  const legendTop = {
    id: 'pd-top',
    name: 'Palkia & Dialga Legend',
    set: 'Triumphant',
    number: 'Top | 101/102',
    rarity: 'Top',
    version: 'v260112',
    pokedexSort: 484_000_000 + 80_000,
    expansionSort: 80003,
    collectorSort: 101,
    productType: 'card',
  };
  const legendBottom = {
    id: 'pd-bot',
    name: 'Palkia & Dialga Legend',
    set: 'Triumphant',
    number: 'Bottom | 102/102',
    rarity: 'Bottom',
    version: 'v260114',
    pokedexSort: 484_000_000 + 80_000,
    expansionSort: 80003,
    collectorSort: 102,
    productType: 'card',
  };
  const shown = filterSearchCards(
    [legendBottom, team, legendTop, charizard],
    { sort: 'pokedex', expandPokedexPairs: true },
  );
  assert.deepEqual(
    shown.map((row) => `${row.id}@${row.pokedexSlot || ''}:${row.rarity || ''}`),
    [
      'ch@:',
      'cb@6:',
      'pd-top@:Top',
      'pd-bot@:Bottom',
      'cb@654:',
    ],
  );
});
