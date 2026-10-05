'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const { runWithGame, isPokemonGame } = require('./_marketplace_game');

const TARGET = path.join(__dirname, '_marketplace_react_sql.js');

// Columns that exist only on the Pokemon marketplace_search_candidates
// (060 emoji, version/illustrator denorms). Satellite DBs reject them.
const POKEMON_ONLY = /\bc\.(emoji|version|rarity_kind|art_layout|artist|illustrator)\b/;

const SHU_CAVALRY = {
  card_id: '62210',
  ct_id: '31105',
  name: 'Shu Cavalry',
  image_url: 'https://cdn.pokoin.com/magic/31105_shu-cavalry.jpg',
  cdn_image_url: 'https://cdn.pokoin.com/magic/31105_shu-cavalry.jpg',
  preview_image_url: null,
  homepage_image_url: null,
  set_name: 'Portal Three Kingdoms',
  rarity: 'Common',
  card_number: '',
  item_kind: 'single',
  product_type: 'card',
};

function loadSql(query) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db' && parent && parent.filename === TARGET) {
      return { marketplaceQuery: query, isPokemonGame };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[TARGET];
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

/** A satellite DB: 42703 on Pokemon-only candidate columns, like Postgres. */
function satelliteQuery(calls) {
  return async (text, values) => {
    calls.push(text);
    const match = String(text).match(POKEMON_ONLY);
    if (match) {
      const error = new Error(`column ${match[0]} does not exist`);
      error.code = '42703';
      throw error;
    }
    if (/where c\.card_id = \$1::bigint/.test(text)) {
      return { rows: Number(values[0]) === 62210 ? [{ ...SHU_CAVALRY }] : [] };
    }
    if (/c\.name = \$1/.test(text)) {
      return { rows: [{ ...SHU_CAVALRY }] };
    }
    return { rows: [] };
  };
}

test('Magic card lookup does not select Pokemon-only candidate columns', async () => {
  const calls = [];
  const sql = loadSql(satelliteQuery(calls));
  const row = await runWithGame('magic', () => sql.readCandidateByCardId(62210));
  assert.equal(row.name, 'Shu Cavalry');
  assert.equal(row.ct_id, '31105');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], POKEMON_ONLY);
  assert.match(calls[0], /''::text as emoji/);
});

test('Magic card-page sibling and neighbor reads stay on satellite columns', async () => {
  const calls = [];
  const sql = loadSql(satelliteQuery(calls));
  await runWithGame('magic', async () => {
    const siblings = await sql.readSetSiblings(SHU_CAVALRY, 64);
    assert.equal(siblings[0].name, 'Shu Cavalry');
    await sql.readNameSetSiblings(SHU_CAVALRY, 24);
    await sql.readSetNeighbors(SHU_CAVALRY.set_name, 62210, 6);
    await sql.readCandidatesByCardIds([62210]);
  });
  assert.ok(calls.length >= 4);
  for (const text of calls) {
    assert.doesNotMatch(text, POKEMON_ONLY);
  }
});

test('Pokemon card lookup still reads the stored emoji and version', async () => {
  const calls = [];
  const sql = loadSql(async (text) => {
    calls.push(text);
    return { rows: [] };
  });
  await runWithGame('pokemon', () => sql.readCandidateByCardId(826452));
  assert.match(calls[0], /\bc\.emoji\b/);
  assert.match(calls[0], /\bc\.version\b/);
});
