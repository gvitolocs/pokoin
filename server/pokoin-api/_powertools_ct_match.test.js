'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  stockMatchKey,
  compactCollector,
  reconcilePowerToolsWithCardTrader,
  gamesFromCardTraderProducts,
} = require('./_powertools_ct_match');
const { importCsvText, assignStackPositions, assignPowerToolsLocations, parseLocation, parsePowerToolsLocation } = require('./_stock_csv');
const { ctConditionToPokoin } = require('./_cardtrader_inventory_sync_core');

const FIXTURE = [
  path.join(__dirname, '../../../cardvault/pokemon_card_vault/api/fixtures/powertools-F006-16.csv'),
  '/home/nez/Projects/cardvault/pokemon_card_vault/api/fixtures/powertools-F006-16.csv',
  '/tmp/cardvault-security/pokemon_card_vault/api/fixtures/powertools-F006-16.csv',
].find((p) => fs.existsSync(p));

test('collector numbers: bare, padded, n/m, and rarity prefix align', () => {
  assert.equal(compactCollector('069/101'), '69');
  assert.equal(compactCollector('69/101'), '69');
  assert.equal(compactCollector('69'), '69');
  assert.equal(compactCollector('102/131'), '102');
  assert.equal(compactCollector('102'), '102');
  assert.equal(compactCollector('Rare | 070/131'), '70');
  assert.equal(compactCollector('Holo Rare | 008/182'), '8');
});

test('CT Slightly Played / Heavily Played map to Pokoin SP / PL (same as PT EX / HP)', () => {
  assert.equal(ctConditionToPokoin('Slightly Played'), 'SP');
  assert.equal(ctConditionToPokoin('Near Mint'), 'NM');
  assert.equal(ctConditionToPokoin('Moderately Played'), 'MP');
  assert.equal(ctConditionToPokoin('Heavily Played'), 'PL');
  assert.equal(ctConditionToPokoin('Poor'), 'Poor');
  assert.equal(ctConditionToPokoin('LP'), 'SP'); // legacy stored grade
  assert.equal(ctConditionToPokoin('HP'), 'PL');
});

test('stock match key equates PT bare cn + EX with CT n/m + Slightly Played', () => {
  const pt = stockMatchKey({
    name: 'Bug Catching Set',
    collectorNumber: '102',
    condition: 'SP', // EX → SP via CSV import
    language: 'IT',
    reverse: false,
  });
  const ct = stockMatchKey({
    name: 'Bug Catching Set',
    collectorNumber: '102/131',
    condition: 'SP', // Slightly Played → SP
    language: 'IT',
    reverse: false,
  });
  assert.equal(pt, ct);
});

test('legacy LP on a CT listing still matches PT SP', () => {
  const pt = stockMatchKey({
    name: 'Carmine',
    collectorNumber: '103',
    condition: 'SP',
    language: 'IT',
    reverse: false,
  });
  const ct = stockMatchKey({
    name: 'Carmine',
    collectorNumber: '103/131',
    condition: 'LP',
    language: 'IT',
    reverse: false,
  });
  assert.equal(pt, ct);
});

test('bare FUOCOBOMBA location stays box name; stackSize 1 assigns ·N slots', () => {
  const parsed = parseLocation('FUOCOBOMBA 006 - 16');
  assert.equal(parsed.box, 'FUOCOBOMBA 006 - 16');
  const slotted = assignStackPositions([
    { name: 'A', location: 'FUOCOBOMBA 006 - 16' },
    { name: 'B', location: 'FUOCOBOMBA 006 - 16' },
    { name: 'C', location: 'other' },
  ], 1);
  assert.equal(slotted[0].location, 'FUOCOBOMBA 006 - 16·1');
  assert.equal(slotted[1].location, 'FUOCOBOMBA 006 - 16·2');
  assert.equal(slotted[2].location, 'other·1');
});

test('stackSize > 1 fills box·stack·pos and keeps structured ·strings', () => {
  const slotted = assignStackPositions([
    { location: 'boxA' },
    { location: 'boxA' },
    { location: 'boxA' },
    { location: 'boxA·2·1' },
  ], 2);
  assert.equal(slotted[0].location, 'boxA·1·1');
  assert.equal(slotted[1].location, 'boxA·1·2');
  assert.equal(slotted[2].location, 'boxA·2·1');
  assert.equal(slotted[3].location, 'boxA·2·1'); // already structured, kept
});

test('Power Tools fixture rows match simulated CT products and keep locations', () => {
  assert.ok(FIXTURE, 'powertools-F006-16.csv fixture missing');
  const csv = fs.readFileSync(FIXTURE, 'utf8');
  const imported = importCsvText(csv, { format: 'powertools', stackSize: 1 });
  const ptRows = imported.results.filter((r) => r.ok).map((r) => r.row);
  assert.equal(ptRows.length, 47);
  assert.ok(ptRows.every((r) => String(r.location).startsWith('FUOCOBOMBA 006 - 16')));

  // Simulate CardTrader export products from the same PT identities.
  const products = ptRows.map((row, index) => ({
    id: String(1000 + index),
    name: row.name,
    condition: row.condition, // already Pokoin-normalized from CSV
    language: row.language,
    reverse: row.reverse === true,
    firstEdition: row.firstEdition === true,
    blueprintId: String(index + 1),
    quantity: row.quantity,
    raw: {
      expansion: { name_en: row.setName },
      properties_hash: {
        // CT usually ships collector as n/m
        collector_number: row.collectorNumber.includes('/')
          ? row.collectorNumber
          : `${row.collectorNumber}/131`,
        condition: row.condition === 'SP' ? 'Slightly Played'
          : row.condition === 'MP' ? 'Moderately Played'
            : row.condition === 'PL' ? 'Heavily Played'
              : row.condition === 'Poor' ? 'Poor'
                : 'Near Mint',
      },
    },
  }));

  const result = reconcilePowerToolsWithCardTrader(products, ptRows, 'pokemon');
  assert.equal(result.matched.length, 47, `matched=${result.matched.length} ctOnly=${result.ctOnly.length} ptOnly=${result.ptOnly.length}`);
  assert.equal(result.ctOnly.length, 0);
  assert.equal(result.ptOnly.length, 0);
  for (const hit of result.matched) {
    assert.ok(hit.location.startsWith('FUOCOBOMBA 006 - 16'), hit.location);
  }
});

test('set soft-match picks Prismatic Evolutions when two collector twins exist', () => {
  const products = [
    {
      id: 'a',
      name: 'Bug Catching Set',
      condition: 'NM',
      language: 'IT',
      reverse: true,
      raw: {
        expansion: { name_en: 'Prismatic Evolutions' },
        properties_hash: { collector_number: '102/131' },
      },
    },
  ];
  const pt = [
    {
      name: 'Bug Catching Set',
      collectorNumber: '102',
      condition: 'NM',
      language: 'IT',
      reverse: true,
      setName: 'Twilight Masquerade',
      location: 'wrong-box',
      quantity: 1,
    },
    {
      name: 'Bug Catching Set',
      collectorNumber: '102',
      condition: 'NM',
      language: 'IT',
      reverse: true,
      setName: 'Prismatic Evolutions',
      location: 'FUOCOBOMBA 006 - 16·1',
      quantity: 1,
    },
  ];
  const result = reconcilePowerToolsWithCardTrader(products, pt, 'pokemon');
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].location, 'FUOCOBOMBA 006 - 16·1');
  assert.equal(result.ptOnly.length, 1);
  assert.equal(result.ptOnly[0].location, 'wrong-box');
});

test('gamesFromCardTraderProducts groups supported games', () => {
  const games = gamesFromCardTraderProducts(
    [
      { id: '1', gameId: 5 },
      { id: '2', gameId: 5 },
      { id: '3', gameId: 15 },
      { id: '4', gameId: 999 },
    ],
    (product) => {
      if (product.gameId === 5) return 'pokemon';
      if (product.gameId === 15) return 'one_piece';
      return '';
    },
  );
  assert.deepEqual(games, [
    { id: 'pokemon', count: 2 },
    { id: 'one_piece', count: 1 },
  ]);
});

test('trailing_stack parses FUOCOBOMBA 006 - 16 as box + stack 16', () => {
  const parsed = parsePowerToolsLocation('FUOCOBOMBA 006 - 16', 'trailing_stack');
  assert.equal(parsed.box, 'FUOCOBOMBA 006');
  assert.equal(parsed.stack, 16);
});

test('Power Tools sync keeps box·stack without inventing card positions', () => {
  const { rows, overflows } = assignPowerToolsLocations([
    { name: 'A', location: 'FUOCOBOMBA 006 - 16' },
    { name: 'B', location: 'FUOCOBOMBA 006 - 16' },
    { name: 'C', location: 'FUOCOBOMBA 006 - 16' },
  ], { stackSize: 2, locationParse: 'trailing_stack', numberedInStack: false });
  assert.equal(rows[0].location, 'FUOCOBOMBA 006·16');
  assert.equal(rows[1].location, 'FUOCOBOMBA 006·16');
  assert.equal(rows[2].location, 'FUOCOBOMBA 006·16');
  assert.equal(overflows.length, 1);
  assert.equal(overflows[0].count, 3);
  assert.equal(overflows[0].stackSize, 2);
});

test('numberedInStack adds ·pos and respects capacity', () => {
  const { rows } = assignPowerToolsLocations([
    { name: 'A', location: 'boxA - 1' },
    { name: 'B', location: 'boxA - 1' },
    { name: 'C', location: 'boxA - 1' },
  ], { stackSize: 2, locationParse: 'trailing_stack', numberedInStack: true });
  assert.equal(rows[0].location, 'boxA·1·1');
  assert.equal(rows[1].location, 'boxA·1·2');
  assert.equal(rows[2].location, 'boxA·2·1'); // spills
});

test('importCsvText powerToolsSync does not invent ·N on bare box', () => {
  const csv = 'cardmarketId,quantity,name,set,setCode,cn,condition,language,isFirstEd,isReverseHolo,isSigned,finishType,price,comment,location\n'
    + '1,1,Alpha,Set,S,1,NM,English,,,,,1,,BOX1\n'
    + '2,1,Beta,Set,S,2,NM,English,,,,,1,,BOX1\n';
  const imported = importCsvText(csv, {
    format: 'powertools',
    powerToolsSync: true,
    stackSize: 60,
    numberedInStack: false,
    locationParse: 'as_is',
  });
  const locs = imported.results.filter((r) => r.ok).map((r) => r.row.location);
  assert.deepEqual(locs, ['BOX1', 'BOX1']);
});
