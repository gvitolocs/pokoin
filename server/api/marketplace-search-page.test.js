'use strict';

// Route contract for the pokoin-web-owned /api/marketplace-search-page BFF.
// Assembled in a temp dir against the real route file and the real
// _marketplace_react_card mapper; the engine, DB, and title-language modules
// are stubs (the route injects them per request).
//
// Invariants proven here:
//   total rides the payload beside count and answers the SAME query object
//   as the rows; jumbo rows flow to the Product (productSearchOnly) payload;
//   bare-array loads keep total null so the UI never invents a number.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const srcDir = __dirname;

const STUBS = {
  // Engine stub: the route injects its own rowsForCards in these tests; the
  // top-level require only has to resolve.
  'marketplace-cards.js': `module.exports = {
    rowsForCards: async () => [],
    productFacetRows: async () => [],
  };`,
  '_marketplace_db.js': `module.exports = {
    marketplaceQuery: async () => ({ rows: [] }),
    marketplaceDatabaseUrl: () => 'postgres://stub.example/db',
  };`,
  '_marketplace_game.js': `module.exports = {
    parseGameFromRequest: () => 'pokemon',
    runWithGame: async (game, fn) => fn(),
    isPokemonGame: () => true,
  };`,
  '_marketplace_multigame_sql.js': `module.exports = { rowsForMultigameCards: async () => [] };`,
  '_marketplace_react_sql.js': `module.exports = { overlayCheapestOnRows: async (rows) => rows };`,
  '_catalog_title_language.js': `module.exports = { attachTitleLanguageOnRows: async (rows) => rows };`,
  '_marketplace_row.js': `module.exports = {
    normalizeMarketplaceRow: (row) => ({ ...row }),
    rewriteCdnPokoinPrefix: (url) => String(url || ''),
    isMarketAvailable: () => false,
  };`,
  '_marketplace_card_emoji.js': `module.exports = { withCardEmojiFields: (row) => ({ ...row }), cardEmojiFields: () => ({}) };`,
};

function assemble() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-search-page-'));
  for (const name of [
    'marketplace-search-page.js',
    '_marketplace_react_card.js',
    '_print_bucket.js',
  ]) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dir, name));
  }
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  delete require.cache[require.resolve(path.join(dir, 'marketplace-search-page.js'))];
  return require(path.join(dir, 'marketplace-search-page.js')).createHandler;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

const BASE_ROW = (id, name) => ({
  card_id: id,
  name,
  set_name: 'Team Up',
  card_number: '89/181',
  image_url: `https://cdn.pokoin.com/${id}_card.jpg`,
});

test('search-page BFF pages Meili rows and returns product facets', async () => {
  const createHandler = assemble();
  const handler = createHandler({
    overlayCheapestOnRows: async (rows) => rows,
    rowsForCards: async ({ query, limit, offset, lightHydrate }) => {
      assert.equal(query, 'Charizard');
      assert.equal(offset, 0);
      assert.equal(limit, 101);
      assert.equal(lightHydrate, true);
      return Array.from({ length: 101 }, (_, index) => ({
        card_id: 1000 + index,
        name: `Charizard ${index}`,
        set_name: 'Base Set',
        card_number: `${index}/102`,
        image_url: `https://cdn.pokoin.com/${500 + index}_charizard.jpg`,
        preview_image_url: `https://cdn.pokoin.com/previews/${500 + index}_charizard.jpg`,
      }));
    },
    productFacetRows: async () => ([
      { productType: 'card', count: 80 },
      { productType: 'booster_box', count: 2 },
    ]),
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-search-page?query=Charizard',
    headers: { host: 'api.pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cards.length, 100);
  assert.equal(res.body.hasMore, true);
  assert.equal(res.body.cards[0].gridImageUrl.includes('/previews/'), false);
  assert.equal(res.body.facets.products[0].productType, 'card');
});

test('search-page returns the same-predicate total beside the page count', async () => {
  const createHandler = assemble();
  const handler = createHandler({
    overlayCheapestOnRows: async (rows) => rows,
    rowsForCards: async ({ withTotal }) => {
      assert.equal(withTotal, true);
      return {
        rows: Array.from({ length: 3 }, (_, index) => BASE_ROW(2000 + index, 'Pikachu GX')),
        total: 37,
      };
    },
    productFacetRows: async () => [],
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-search-page?query=pikachu%20gx&includeFacets=0',
    headers: { host: 'api.pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 37);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.hasMore, false);
});

test('Product tab (productSearchOnly) payload carries jumbo rows and their total', async () => {
  const createHandler = assemble();
  const seen = {};
  const handler = createHandler({
    overlayCheapestOnRows: async (rows) => rows,
    rowsForCards: async (args) => {
      seen.productSearchOnly = args.productSearchOnly;
      seen.withTotal = args.withTotal;
      return {
        rows: [
          { ...BASE_ROW(554368, 'Lucario V'), card_number: 'Jumbo Oversized | 078', product_type: 'jumbo', item_kind: 'single' },
          { ...BASE_ROW(780048, 'Transformation Tome'), product_type: 'sealed_product', item_kind: 'product' },
        ],
        total: 2,
      };
    },
    productFacetRows: async () => [],
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-search-page?query=lucario&productSearchOnly=1&includeFacets=0',
    headers: { host: 'api.pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.productSearchOnly, true);
  assert.equal(seen.withTotal, true);
  assert.equal(res.body.total, 2);
  const jumbo = res.body.cards.find((card) => String(card.number || '').includes('Jumbo Oversized'));
  assert.ok(jumbo, 'jumbo rows must ride the Product payload');
  assert.ok(res.body.cards.some((card) => card.name === 'Transformation Tome'));
});

test('search-page keeps total null for bare-array row loads', async () => {
  const createHandler = assemble();
  const handler = createHandler({
    overlayCheapestOnRows: async (rows) => rows,
    rowsForCards: async () => ([BASE_ROW(1, 'Dawn')]),
    productFacetRows: async () => [],
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-search-page?query=Dawn',
    headers: { host: 'api.pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, null);
  assert.equal(res.body.count, 1);
});

test('print_language reaches the engine and defaults to all', async () => {
  const createHandler = assemble();
  const seen = [];
  const handler = createHandler({
    overlayCheapestOnRows: async (rows) => rows,
    rowsForCards: async (args) => {
      seen.push(args.printLanguage);
      return { rows: [], total: 0 };
    },
    productFacetRows: async () => [],
  });
  await handler({
    method: 'GET',
    url: '/api/marketplace-search-page?query=dawn&print_language=japanese&includeFacets=0',
    headers: { host: 'api.pokoin.com' },
  }, mockRes());
  await handler({
    method: 'GET',
    url: '/api/marketplace-search-page?query=dawn&includeFacets=0',
    headers: { host: 'api.pokoin.com' },
  }, mockRes());
  assert.deepEqual(seen, ['japanese', 'all']);
});
