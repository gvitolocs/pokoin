'use strict';

// Pokoin-web owns the marketplace search endpoint (server/api). These tests
// assemble the ported engine in a temp dir with stubbed DB/Meili modules and
// assert the search-universe contract against the exact file that ships to
// the Pi release:
//
//   jumbo ⊂ product — productSearchOnly (the Product tab universe) matches
//   sealed products AND product_type 'jumbo'; productType stays an exact
//   narrow filter (card singles, /product/jumbo); withTotal answers the
//   same WHERE as the rows, and bare-array loads stay backward compatible.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const srcDir = __dirname;

const DB_STUB = `
const capture = require('./_test_capture');
module.exports = {
  marketplaceQuery: async (sql, values) => {
    capture.queries.push({ sql, values });
    if (/to_regclass/.test(sql)) {
      return { rows: [{ relation: 'public.cheapest_homepage_cache_blueprint' }] };
    }
    return { rows: capture.fixtureRows };
  },
  marketplaceDatabaseUrl: () => 'postgres://stub.example/db',
};
`;

const IDENTITY_ROW_STUBS = {
  '_marketplace_row.js': `module.exports = { normalizeMarketplaceRow: (row) => ({ ...row }) };`,
  '_marketplace_card_emoji.js': `module.exports = { withCardEmojiFields: (row) => ({ ...row }), cardEmojiFields: () => ({}) };`,
  '_marketplace_card_rarity.js': `module.exports = { projectedRaritySql: () => 'null as rarity' };`,
  '_marketplace_image_log.js': `module.exports = { recordCardsImages: () => {} };`,
  '_marketplace_watchlist_analytics.js': `module.exports = {
    watchlistAnalyticsJoin: () => '',
    watchlistCountColumn: () => '0 as watchlist_count',
  };`,
  '_marketplace_cart_analytics.js': `module.exports = {
    cartAnalyticsJoin: () => '',
    cartHolderCountColumn: () => '0 as cart_holder_count',
  };`,
  '_marketplace_search_engine.js': `module.exports = { useMeiliSearchForLanguage: () => globalThis.__useMeili === true };`,
  'marketplace-search-candidates.js': `module.exports = {
    rowsForSearchTerm: async (term, limit, offset, lang, debug, previousContext, options) => {
      const capture = require('./_test_capture');
      capture.meiliCalls.push(options || {});
      if (options && options.withTotal === true) {
        return { rows: [{ card_id: 91, name: 'Meili Row', set_name: 'Base Set', card_number: '1/102' }], total: 7 };
      }
      return [{ card_id: 91, name: 'Meili Row', set_name: 'Base Set', card_number: '1/102' }];
    },
  };`,
  'marketplace-autocomplete.js': `module.exports = {};`,
};

function assemble() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-search-engine-'));
  for (const name of ['marketplace-cards.js', '_print_bucket.js']) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, '_test_capture.js'), 'module.exports = { queries: [], meiliCalls: [], fixtureRows: [] };');
  fs.writeFileSync(path.join(dir, '_marketplace_db.js'), DB_STUB);
  for (const [name, body] of Object.entries(IDENTITY_ROW_STUBS)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function fixtureRow(id, name, productType, itemKind) {
  return {
    card_id: id,
    ct_id: id,
    name,
    set_name: 'Base Set',
    card_number: productType === 'jumbo' ? 'Jumbo Oversized | 009' : '4/102',
    item_kind: itemKind,
    product_type: productType,
    image_url: `https://cdn.pokoin.com/${id}_card.jpg`,
    total_count: 3,
  };
}

function setupFixture(dir, rows) {
  const capturePath = path.join(dir, '_test_capture.js');
  fs.writeFileSync(capturePath, `module.exports = {
    queries: [],
    meiliCalls: [],
    fixtureRows: ${JSON.stringify(rows)},
  };`);
}

function loadEngine(dir) {
  delete require.cache[require.resolve(path.join(dir, 'marketplace-cards.js'))];
  return require(path.join(dir, 'marketplace-cards.js'));
}

function mainSearchSql(dir) {
  const capture = require(path.join(dir, '_test_capture.js'));
  const found = capture.queries.find((q) => /from settings/.test(q.sql) && /marketplace_search_candidates/.test(q.sql));
  assert.ok(found, 'engine did not run the candidates search query');
  return found;
}

test('productSearchOnly (Product tab universe) matches sealed products OR the jumbo subtype', async () => {
  globalThis.__useMeili = false;
  const dir = assemble();
  setupFixture(dir, [
    fixtureRow(1, 'Mimikyu ex Box', 'sealed_product', 'product'),
    fixtureRow(2, 'Blastoise EX', 'jumbo', 'single'),
    fixtureRow(3, 'Charizard GX', 'jumbo', 'single'),
  ]);
  const engine = loadEngine(dir);
  const result = await engine.rowsForCards({
    query: 'blastoise',
    productSearchOnly: true,
    withTotal: true,
    limit: 5,
    searchLanguage: 'en',
  });
  const { sql, values } = mainSearchSql(dir);
  assert.match(
    sql,
    /and \(marketplace_search_candidates\.item_kind = 'product' or marketplace_search_candidates\.product_type = 'jumbo'\)/,
    'Product universe must be sealed products OR the jumbo subtype',
  );
  assert.ok(!values.includes('jumbo'), 'the universe clause is not an exact product_type filter');
  assert.equal(result.total, 3, 'total answers the same WHERE as the rows');
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.some((row) => row.name === 'Blastoise EX' && row.product_type === 'jumbo'));
  assert.ok(!('total_count' in result.rows[0]), 'the window count never leaks into rows');
});

test('productType=jumbo stays an exact narrow filter (/product/jumbo aisle)', async () => {
  globalThis.__useMeili = false;
  const dir = assemble();
  setupFixture(dir, [fixtureRow(2, 'Blastoise EX', 'jumbo', 'single')]);
  const engine = loadEngine(dir);
  const result = await engine.rowsForCards({
    query: '',
    productType: 'jumbo',
    withTotal: true,
    limit: 5,
    searchLanguage: 'en',
  });
  const { sql, values } = mainSearchSql(dir);
  assert.match(sql, /and marketplace_search_candidates\.product_type = \$1/);
  assert.deepEqual(values[0], 'jumbo');
  assert.doesNotMatch(sql, /item_kind = 'product' or/);
  assert.equal(result.total, 3);
});

test('productType=card (Singles) keeps the exact card filter with no product universe', async () => {
  globalThis.__useMeili = false;
  const dir = assemble();
  setupFixture(dir, [fixtureRow(4, 'Charizard', 'card', 'single')]);
  const engine = loadEngine(dir);
  await engine.rowsForCards({ query: '', productType: 'card', limit: 5, searchLanguage: 'en' });
  const { sql, values } = mainSearchSql(dir);
  assert.match(sql, /and marketplace_search_candidates\.product_type = \$1/);
  assert.deepEqual(values[0], 'card');
  assert.doesNotMatch(sql, /item_kind = 'product'/);
});

test('withTotal omitted returns a bare array (older callers unchanged)', async () => {
  globalThis.__useMeili = false;
  const dir = assemble();
  setupFixture(dir, [fixtureRow(4, 'Charizard', 'card', 'single')]);
  const engine = loadEngine(dir);
  const rows = await engine.rowsForCards({ query: 'charizard', limit: 5, searchLanguage: 'en' });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
});

test('productType=jumbo bypasses the Meili window: the aisle rides the exact SQL filter', async () => {
  globalThis.__useMeili = true;
  const dir = assemble();
  setupFixture(dir, [fixtureRow(2, 'Blastoise EX', 'jumbo', 'single')]);
  const engine = loadEngine(dir);
  const capture = require(path.join(dir, '_test_capture.js'));
  const result = await engine.rowsForCards({
    query: 'charizard',
    productType: 'jumbo',
    withTotal: true,
    limit: 5,
    searchLanguage: 'en',
  });
  assert.equal(capture.meiliCalls.length, 0, 'productType=jumbo must never depend on Meili text ranking');
  const { sql, values } = mainSearchSql(dir);
  assert.match(sql, /and marketplace_search_candidates\.product_type = \$1/);
  assert.deepEqual(values[0], 'jumbo');
  assert.equal(result.total, 3);
  assert.equal(result.rows[0].name, 'Blastoise EX');
});

test('productSearchOnly never rides the Meili window (SQL universe owns the predicate)', async () => {
  globalThis.__useMeili = true;
  const dir = assemble();
  setupFixture(dir, [fixtureRow(1, 'Mimikyu ex Box', 'sealed_product', 'product')]);
  const engine = loadEngine(dir);
  const capture = require(path.join(dir, '_test_capture.js'));
  await engine.rowsForCards({ query: 'mimikyu', productSearchOnly: true, limit: 5, searchLanguage: 'en' });
  assert.equal(capture.meiliCalls.length, 0, 'productSearchOnly must use the SQL universe, not Meili text hits');
});
