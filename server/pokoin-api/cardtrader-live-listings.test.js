'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.join(__dirname, 'cardtrader-live-listings.js');

/** Load the handler with the Pi-only helpers stubbed for one game. */
function loadFor(game) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') return { marketplaceQuery: async () => ({ rows: [] }) };
    if (request === './_marketplace_game') return { currentGame: () => game, normalizeGame: (g) => g };
    if (request === './_seller_comment_filter') return { publicSellerComment: () => '', sellerCommentFields: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

test('non-Pokemon cards resolve their CardTrader blueprint from the catalog ct_id', async () => {
  const live = loadFor('one_piece');
  const calls = [];
  const mapping = await live.resolveCardTraderBlueprintId({ cardId: '710802' }, async (sql, values) => {
    calls.push(sql);
    return { rows: [{ pokoin_card_id: '710802', cardtrader_blueprint_id: '355401' }] };
  });
  assert.equal(mapping.cardtraderBlueprintId, '355401');
  assert.equal(mapping.mappingSource, 'one_piece_catalog_ct_id');
  assert.match(calls[0], /ct_id/);
  assert.doesNotMatch(calls[0], /cardtrader_pokemon_blueprints/);
});

test('Pokemon resolves through ct_id too (card_id is 2 × blueprint)', async () => {
  const live = loadFor('pokemon');
  const calls = [];
  const mapping = await live.resolveCardTraderBlueprintId({ cardId: '633380' }, async (sql) => {
    calls.push(sql);
    return { rows: [{ pokoin_card_id: '633380', cardtrader_blueprint_id: '316690' }] };
  });
  assert.equal(mapping.cardtraderBlueprintId, '316690');
  assert.match(calls[0], /ct_id/);
});

test('a card without ct_id falls back to the legacy blueprint lookup', async () => {
  const live = loadFor('pokemon');
  const calls = [];
  await live.resolveCardTraderBlueprintId({ cardId: '75481' }, async (sql) => {
    calls.push(sql);
    return { rows: calls.length === 1 ? [] : [{ pokoin_card_id: '75481', cardtrader_blueprint_id: '75481' }] };
  });
  assert.match(calls[1], /cardtrader_pokemon_blueprints/);
});

test('game-specific CardTrader language keys are read', () => {
  const live = loadFor('one_piece');
  assert.equal(live.gameLanguageProperty({ condition: 'Near Mint', onepiece_language: 'jp' }), 'jp');
  assert.equal(live.gameLanguageProperty({ condition: 'Near Mint' }), '');
});

test('an explicit request game wins over the Pokemon request context', async () => {
  const live = loadFor('pokemon');
  const calls = [];
  const mapping = await live.resolveCardTraderBlueprintId({ cardId: '710802', game: 'one_piece' }, async (sql) => {
    calls.push(sql);
    return { rows: [{ pokoin_card_id: '710802', cardtrader_blueprint_id: '355401' }] };
  });
  assert.equal(mapping.cardtraderBlueprintId, '355401');
  assert.match(calls[0], /ct_id/);
});
