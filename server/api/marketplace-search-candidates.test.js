'use strict';

// Regression tests for the vendored search candidate engine. The engine runs
// in a temp dir against stubbed DB/Meili modules, mirroring the
// search-universe.test.js harness, so the exact file that ships to the Pi
// release is what executes here.
//
// Production incident (2026-10-01): the withTotal branch returned
// attachThemePacks(...) without await, so { rows } was a Promise. The
// search-page caller runs .filter on rows for productType/print chips, so
// every Singles search died with "next.filter is not a function" and plain
// searches silently painted zero rows (count 0 beside a non-zero total).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const srcDir = __dirname;

const STUBS = {
  '_marketplace_db.js': `
    module.exports = {
      marketplaceQuery: async () => ({
        rows: [{
          card_id: 91,
          name: 'Blastoise',
          set_name: 'Base Set',
          card_number: '4/102',
          product_type: 'card',
          item_kind: 'single',
        }],
      }),
      marketplaceNameSearchQuery: async () => ({ rows: [] }),
      marketplaceVariationSearchQuery: async () => ({ rows: [] }),
    };
  `,
  '_marketplace_card_emoji.js': `
    module.exports = { withCardEmojiFields: (row) => ({ ...row }) };
  `,
  '_search_debug_auth.js': `
    module.exports = { authorizeSearchDebugRequest: async () => null };
  `,
  '_marketplace_search_engine.js': `
    module.exports = {
      marketplaceSearchEngine: () => 'meili',
      marketplaceSearchShadowEnabled: () => false,
      useMeiliSearchForLanguage: () => true,
      useRedisSearch: () => false,
    };
  `,
  '_redis_search.js': `
    module.exports = {
      redisSearchCandidates: async () => ({ hits: [], estimatedTotalHits: 0, exhaustive: true }),
    };
  `,
  '_meili_marketplace.js': `
    const capture = require('./_test_capture');
    module.exports = {
      meiliMarketplaceCandidates: async () => ({
        hits: capture.meiliHits,
        estimatedTotalHits: capture.estimatedTotalHits,
      }),
    };
  `,
  '_marketplace_canonical_path.js': `
    module.exports = { canonicalPathForRow: () => '' };
  `,
  // attachThemePacks resolves theme packs through this module: the regression
  // is that the withTotal branch waits for it before returning rows.
  '_marketplace_react_sql.js': `
    const capture = require('./_test_capture');
    module.exports = { readCardThemePacks: async () => capture.themePacks };
  `,
};

function assemble() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-search-candidates-'));
  fs.copyFileSync(
    path.join(srcDir, 'marketplace-search-candidates.js'),
    path.join(dir, 'marketplace-search-candidates.js'),
  );
  fs.writeFileSync(path.join(dir, '_test_capture.js'), `module.exports = {
    meiliHits: [{ card_id: '91', meili_rank: 1 }],
    estimatedTotalHits: 7,
    themePacks: new Map([['91', 'theme']]),
  };`);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function loadEngine(dir) {
  const resolved = path.join(dir, 'marketplace-search-candidates.js');
  delete require.cache[require.resolve(resolved)];
  return require(resolved);
}

test('withTotal resolves rows to a real array, never the attachThemePacks promise', async () => {
  const dir = assemble();
  const engine = loadEngine(dir);
  const payload = await engine.rowsForSearchTerm('blastoise', 5, 0, 'en', null, null, {
    withTotal: true,
    lightHydrate: true,
    printLanguage: 'all',
  });
  assert.ok(Array.isArray(payload.rows), 'rows must be an array, not a Promise');
  assert.equal(payload.total, 7);
  assert.equal(payload.rows[0].card_id, 91);
});

test('withTotal rows still carry awaited theme packs (vt) after the fix', async () => {
  const dir = assemble();
  const engine = loadEngine(dir);
  const payload = await engine.rowsForSearchTerm('blastoise', 5, 0, 'en', null, null, {
    withTotal: true,
    lightHydrate: true,
    printLanguage: 'all',
  });
  assert.equal(payload.rows[0].vt, 'theme');
});

test('without withTotal the engine still returns a bare array', async () => {
  const dir = assemble();
  const engine = loadEngine(dir);
  const rows = await engine.rowsForSearchTerm('blastoise', 5, 0, 'en', null, null, {});
  assert.ok(Array.isArray(rows));
});

// The production shape: marketplace-cards' Singles tab (productType=card)
// runs the real candidates engine under withTotal and calls .filter on the
// returned rows. Before the await fix this assembled pair threw
// "next.filter is not a function" for every Singles search.
const CARDS_STUBS = {
  ...STUBS,
  '_marketplace_row.js': `module.exports = { normalizeMarketplaceRow: (row) => ({ ...row }) };`,
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
  'marketplace-autocomplete.js': `module.exports = {};`,
};

function assembleCardsEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-search-cards-'));
  for (const name of ['marketplace-cards.js', '_print_bucket.js', 'marketplace-search-candidates.js']) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, '_test_capture.js'), `module.exports = {
    meiliHits: [{ card_id: '91', meili_rank: 1 }],
    estimatedTotalHits: 7,
    themePacks: new Map(),
  };`);
  for (const [name, body] of Object.entries(CARDS_STUBS)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('marketplace-cards Singles (productType=card) survives the real candidates engine', async () => {
  const dir = assembleCardsEngine();
  delete require.cache[require.resolve(path.join(dir, 'marketplace-cards.js'))];
  const cards = require(path.join(dir, 'marketplace-cards.js'));
  const result = await cards.rowsForCards({
    query: 'blastoise',
    productType: 'card',
    withTotal: true,
    limit: 5,
    searchLanguage: 'en',
    lightHydrate: true,
  });
  assert.ok(Array.isArray(result.rows), 'rows must survive as an array through rowsForCards');
  assert.equal(result.total, 7);
  assert.equal(result.rows.length, 1);
});
