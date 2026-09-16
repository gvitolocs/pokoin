import assert from 'node:assert/strict';
import test from 'node:test';
import { filterExpansionCards } from './search-filters.js';
import {
  defaultExpansionSort,
  expansionTilesReady,
  foldOfficialName,
  hasOfficialSetList,
} from './set-official-lists.js';

const celebrations = [
  { id: '342820', name: 'Ho-Oh', number: 'Holo Rare | 001/025' },
  { id: '403528', name: 'Blastoise', number: 'Holo Rare | BS 002' },
  { id: '342822', name: 'Reshiram', number: 'Holo Rare | 002/025' },
  { id: '342824', name: 'Kyogre', number: 'Holo Rare | 003/025' },
  { id: '403530', name: 'Charizard', number: 'Holo Rare | BS 004' },
  { id: '342826', name: 'Palkia', number: 'Holo Rare | 004/025' },
  { id: '342818', name: 'Pikachu', number: 'Holo Rare | 005/025' },
  { id: '403502', name: 'Cosmog', number: '201751' },
  { id: '403532', name: 'Venusaur', number: '' },
  { id: '403534', name: "Team Magma's Groudon", number: 'Holo Rare | 009/095' },
  { id: '403536', name: 'Umbreon Star', number: 'Ultra Rare | 17/17' },
  { id: '403546', name: 'Gardevoir ex δ Delta Species', number: '93/101' },
  { id: '403566', name: 'Mewtwo ex', number: 'Ultra Rare | 54/99' },
  { id: '403522', name: "Professor's Research - Professor Oak", number: '201761' },
  { id: '403524', name: "Professor's Research - Professor Oak", number: '201762' },
  { id: '403526', name: 'Mew', number: 'Gold Secret Rare | 052/052' },
  { id: '343248', name: 'Pikachu', number: 'Gold Metal' },
  { id: '342838', name: 'Mew', number: 'Holo Rare | 011/025' },
];

test('Celebrations, Lost Origin, and Platinum Arceus default to official', () => {
  assert.equal(hasOfficialSetList('celebrations'), true);
  assert.equal(defaultExpansionSort('celebrations'), 'official');
  assert.equal(hasOfficialSetList('lost-origin', 'Lost Origin'), true);
  assert.equal(defaultExpansionSort('lost-origin', 'Lost Origin'), 'official');
  assert.equal(hasOfficialSetList('platinum-arceus', 'Platinum Arceus'), true);
  assert.equal(defaultExpansionSort('platinum-arceus'), 'official');
  assert.equal(defaultExpansionSort('brilliant-stars', 'Brilliant Stars'), 'number');
  assert.equal(foldOfficialName('Umbreon ★'), foldOfficialName('Umbreon Star'));
  assert.equal(foldOfficialName("Professor's Research - Professor Oak"), foldOfficialName("Professor's Research"));
  assert.equal(foldOfficialName("Boss's Orders - Lysandre"), foldOfficialName("Boss's Orders"));
});

test('set desk tiles wait until the full walk is in', () => {
  assert.equal(expansionTilesReady(null, 'celebrations'), false);
  assert.equal(expansionTilesReady({ cards: [{ id: '1' }], hasMore: true }, 'celebrations'), false);
  assert.equal(expansionTilesReady({ cards: [{ id: '1' }], hasMore: false }, 'celebrations'), true);
  assert.equal(expansionTilesReady({ cards: [{ id: '1' }], hasMore: true }, 'lost-origin'), false);
  assert.equal(expansionTilesReady({ cards: [{ id: '1' }], hasMore: false }, 'lost-origin'), true);
});

test('official Celebrations sort is checklist order, not vintage numbers', () => {
  const shown = filterExpansionCards(celebrations, {
    sort: 'official',
    expansionSlug: 'celebrations',
  });
  assert.deepEqual(shown.map((card) => `${card.name} ${card.id}`), [
    'Ho-Oh 342820',
    'Reshiram 342822',
    'Kyogre 342824',
    'Palkia 342826',
    'Pikachu 342818',
    'Mew 342838',
    'Cosmog 403502',
    "Professor's Research - Professor Oak 403522",
    "Professor's Research - Professor Oak 403524",
    'Blastoise 403528',
    'Charizard 403530',
    'Venusaur 403532',
    "Team Magma's Groudon 403534",
    'Gardevoir ex δ Delta Species 403546',
    'Umbreon Star 403536',
    'Mewtwo ex 403566',
  ]);
  assert.equal(shown.some((card) => /mug|glass|jumbo|gold metal/i.test(`${card.name} ${card.number}`)), false);
});

const lostOrigin = [
  { id: '1', name: 'Oddish', number: '001/196' },
  { id: '2', name: 'Gloom', number: '002/196' },
  { id: '3', name: 'Volo', number: 'Ultra Rare | 196/196' },
  { id: '4', name: 'Kyurem VMAX', number: 'Secret Rare | 197/196' },
  { id: '5', name: 'Lost Vacuum', number: 'Secret Rare | 217/196' },
  { id: '6', name: 'Parasect', number: 'Illustration Rare | TG01/TG30' },
  { id: '7', name: "Boss's Orders - Lysandre", number: 'Ultra Rare | TG24/TG30' },
  { id: '8', name: 'Hisuian Zoroark', number: 'Promo 076/196' },
  { id: '9', name: 'Hisuian Zoroark', number: 'Holo Rare | 076/196' },
];

test('official Lost Origin sort is PDF then secrets then Trainer Gallery', () => {
  const shown = filterExpansionCards(lostOrigin, {
    sort: 'official',
    expansionSlug: 'lost-origin',
  });
  assert.deepEqual(shown.map((card) => `${card.name} ${card.id}`), [
    'Oddish 1',
    'Gloom 2',
    'Hisuian Zoroark 9',
    'Volo 3',
    'Kyurem VMAX 4',
    'Lost Vacuum 5',
    'Parasect 6',
    "Boss's Orders - Lysandre 7",
  ]);
});

test('official Platinum Arceus is 1/99 then AR then SH, not AR interleaved with 001', () => {
  const shown = filterExpansionCards([
    { id: 'ar1', name: 'Arceus Lv.100', number: 'Holo Rare | AR1' },
    { id: 'sh10', name: 'Bagon', number: 'SH10 | Holo Rare' },
    { id: 'c1', name: 'Charizard Lv.60', number: 'Holo Rare | 001/099' },
    { id: 'c2', name: 'Froslass', number: 'Holo Rare | 002/099' },
    { id: 'c99', name: 'Tangrowth LV.X', number: 'Holo Rare | 099/099' },
    { id: 'ar9', name: 'Arceus Lv.100', number: 'Holo Rare | AR9' },
    { id: 'sh12', name: 'Shinx', number: 'SH12' },
  ], { sort: 'official', expansionSlug: 'platinum-arceus' });
  assert.deepEqual(shown.map((card) => card.id), [
    'c1', 'c2', 'c99', 'ar1', 'ar9', 'sh10', 'sh12',
  ]);
});

test('set desk drops merch, jumbos, and metal replicas', () => {
  const extras = [
    { id: '1', name: 'Pikachu', number: 'Jumbo Oversized | 058' },
    { id: '2', name: '25th Anniversary "Pikachu" Heat Change Mug', number: '' },
    { id: '3', name: '25th Anniversary "Pikachu" Premium Large Glass', number: '' },
    { id: '4', name: 'Charizard', number: 'Gold Metal' },
    { id: '5', name: 'Pikachu V-UNION', number: 'Jumbo Oversized' },
    { id: '6', name: 'Ho-Oh', number: 'Holo Rare | 001/025' },
  ];
  const shown = filterExpansionCards(extras, { sort: 'number' });
  assert.deepEqual(shown.map((card) => card.name), ['Ho-Oh']);
});
