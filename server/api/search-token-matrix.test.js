'use strict';

// TLC-style bounded enumeration of the search API contract. Instead of
// hand-picking regressions, this assembles the exact files that ship to the
// Pi release (marketplace-cards.js + the real marketplace-search-candidates
// engine) against stubbed DB/Meili modules, then checks the shape invariant
// on EVERY state of the bounded model:
//
//   tokens(query)  × productType × productSearchOnly × printLanguage
//                  × meili engine × lightHydrate × withTotal
//
//   INVARIANT SearchShape: rowsForCards resolves; withTotal=false returns a
//   bare array; withTotal=true returns { rows: Array, total: number|null }
//   and every row is a non-null object.
//
// The 2026-10-01 production outage (Singles tab: "next.filter is not a
// function", plain searches painting 0 rows) violated this invariant on
// every state with withTotal=true — the engine returned attachThemePacks'
// Promise instead of an array. A priori the witness state is the screenshot
// report: query "102 spheal" (collector + name), productType=card, Meili
// engine, withTotal=true. Like the TLC witness configs, the suite pins the
// witness explicitly and asserts the enumeration size so the model can never
// silently shrink.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const srcDir = __dirname;

// Every token kind the engine branches on: bare names, collector numbers
// (n, n/m, #n), set titles + prefix peels, typos, mechanics (gx/vmax/v/ex),
// rarities, art shorthands, era years, energy, tag-team &, case/whitespace.
const QUERIES = [
  '',
  'spheal',
  '  spheal  ',
  'Spheal',
  '102 spheal',                 // the production witness: collector + name
  'spheal 102/109',
  '#102 spheal',
  '102/109 shadowless spheal',
  '1st edition charizard',
  'base set charizard',
  'mewtow evol',                // typo name + set prefix peel
  'call of palkia',             // multi-word set prefix
  'evolutions',                 // set-only browse
  'palkia gx',
  'charizard v max',
  'lugia ex',
  'mega lopunny & jigglypuff gx', // the original report, tag-team &
  'Mega Lopunny & Jigglypuff GX',
  'secret rare umbreon',
  'sir pikachu',
  'illustration ralts',
  '2003 charizard',
  'ex holon',
  'energy',
  'water energy',
  'hgss energy',
  'jumbo spheal',
];

const PRODUCT_TYPES = ['', 'card', 'sealed', 'jumbo'];
const SEARCH_ONLY = [false, true];
const PRINT_LANGS = ['all', 'western', 'japanese', 'chinese', 'korean'];
const MEILI = [false, true];
const LIGHT_HYDRATE = [false, true];
const WITH_TOTAL = [false, true];

const FIXTURE_ROWS = [
  {
    card_id: 91, ct_id: 91, name: 'Spheal', set_name: 'HL - Deoxys',
    card_number: '102/109', product_type: 'card', item_kind: 'single',
    nationality: 'western', image_url: 'https://cdn.pokoin.com/91.jpg',
  },
  {
    card_id: 92, ct_id: 92, name: 'Spheal', set_name: 'HL - Deoxys',
    card_number: '103/109', product_type: 'card', item_kind: 'single',
    nationality: 'japanese', image_url: 'https://cdn.pokoin.com/92.jpg',
  },
  {
    card_id: 93, ct_id: 93, name: 'Spheal Jumbo', set_name: 'Jumbo Pack',
    card_number: 'Jumbo Oversized | 102', product_type: 'jumbo', item_kind: 'single',
    nationality: 'western', image_url: 'https://cdn.pokoin.com/93.jpg',
  },
  {
    card_id: 94, ct_id: 94, name: 'Spheal Binder', set_name: 'Supplies',
    card_number: '', product_type: 'sealed_product', item_kind: 'product',
    nationality: 'western', image_url: 'https://cdn.pokoin.com/94.jpg',
  },
];

const DB_STUB = `
const capture = require('./_test_capture');
module.exports = {
  marketplaceQuery: async (sql) => {
    if (/to_regclass/.test(sql)) {
      return { rows: [{ relation: 'public.cheapest_homepage_cache_blueprint' }] };
    }
    return { rows: capture.fixtureRows.map((row) => ({ ...row })) };
  },
  marketplaceNameSearchQuery: async () => ({ rows: [] }),
  marketplaceVariationSearchQuery: async () => ({ rows: [] }),
  marketplaceDatabaseUrl: () => 'postgres://stub.example/db',
};
`;

const STUBS = {
  '_marketplace_db.js': DB_STUB,
  '_marketplace_card_emoji.js': `module.exports = { withCardEmojiFields: (row) => ({ ...row }), cardEmojiFields: () => ({}) };`,
  '_search_debug_auth.js': `module.exports = { authorizeSearchDebugRequest: async () => null };`,
  // One shared switch drives both marketplace-cards and the candidates engine.
  '_marketplace_search_engine.js': `module.exports = {
    marketplaceSearchEngine: () => (globalThis.__matrixMeili === true ? 'meili' : 'legacy'),
    marketplaceSearchShadowEnabled: () => false,
    useMeiliSearchForLanguage: () => globalThis.__matrixMeili === true,
    useRedisSearch: () => false,
  };`,
  '_redis_search.js': `module.exports = {
    redisSearchCandidates: async () => ({ hits: [], estimatedTotalHits: 0, exhaustive: true }),
  };`,
  '_meili_marketplace.js': `const capture = require('./_test_capture');
    module.exports = { meiliMarketplaceCandidates: async () => ({
      hits: capture.meiliHits, estimatedTotalHits: capture.estimatedTotalHits,
    }) };`,
  '_marketplace_canonical_path.js': `module.exports = { canonicalPathForRow: () => '' };`,
  '_marketplace_react_sql.js': `const capture = require('./_test_capture');
    module.exports = { readCardThemePacks: async () => capture.themePacks };`,
  '_marketplace_row.js': `module.exports = { normalizeMarketplaceRow: (row) => ({ ...row }) };`,
  '_marketplace_card_rarity.js': `module.exports = { projectedRaritySql: () => 'null as rarity' };`,
  '_marketplace_image_log.js': `module.exports = { recordCardsImages: () => {} };`,
  '_marketplace_watchlist_analytics.js': `module.exports = {
    watchlistAnalyticsJoin: () => '', watchlistCountColumn: () => '0 as watchlist_count',
  };`,
  '_marketplace_cart_analytics.js': `module.exports = {
    cartAnalyticsJoin: () => '', cartHolderCountColumn: () => '0 as cart_holder_count',
  };`,
  'marketplace-autocomplete.js': `module.exports = {};`,
};

function assemble() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokoin-search-matrix-'));
  for (const name of ['marketplace-cards.js', '_print_bucket.js', 'marketplace-search-candidates.js']) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, '_test_capture.js'), `module.exports = {
    fixtureRows: ${JSON.stringify(FIXTURE_ROWS)},
    meiliHits: [{ card_id: '91', meili_rank: 1 }, { card_id: '93', meili_rank: 2 }],
    estimatedTotalHits: 7,
    themePacks: new Map(),
  };`);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  delete require.cache[require.resolve(path.join(dir, 'marketplace-cards.js'))];
  delete require.cache[require.resolve(path.join(dir, 'marketplace-search-candidates.js'))];
  return {
    dir,
    cards: require(path.join(dir, 'marketplace-cards.js')),
    engine: require(path.join(dir, 'marketplace-search-candidates.js')),
  };
}

function* optionStates() {
  for (const query of QUERIES) {
    for (const productType of PRODUCT_TYPES) {
      for (const productSearchOnly of SEARCH_ONLY) {
        for (const printLanguage of PRINT_LANGS) {
          for (const meili of MEILI) {
            for (const lightHydrate of LIGHT_HYDRATE) {
              for (const withTotal of WITH_TOTAL) {
                yield { query, productType, productSearchOnly, printLanguage, meili, lightHydrate, withTotal };
              }
            }
          }
        }
      }
    }
  }
}

function assertSearchShape(result, state, via) {
  if (state.withTotal === true) {
    assert.ok(result && typeof result === 'object' && !Array.isArray(result),
      `${via} withTotal=true must return { rows, total } at ${JSON.stringify(state)}`);
    assert.ok(Array.isArray(result.rows),
      `${via} withTotal=true rows must be a real array (Promise rows = "next.filter is not a function" in production) at ${JSON.stringify(state)}`);
    assert.ok(result.total === null || Number.isFinite(result.total),
      `${via} total must be a finite number or null at ${JSON.stringify(state)}`);
    for (const row of result.rows) {
      assert.ok(row && typeof row === 'object', `${via} rows must be row objects at ${JSON.stringify(state)}`);
    }
  } else {
    assert.ok(Array.isArray(result),
      `${via} withTotal=false must return a bare array at ${JSON.stringify(state)}`);
  }
}

test('token × options matrix: the search shape invariant holds on every enumerated state', async () => {
  const { cards } = assemble();
  let checked = 0;
  const violations = [];
  for (const state of optionStates()) {
    globalThis.__matrixMeili = state.meili;
    try {
      const result = await cards.rowsForCards({
        query: state.query,
        productType: state.productType,
        productSearchOnly: state.productSearchOnly,
        searchLanguage: 'en',
        printLanguage: state.printLanguage,
        lightHydrate: state.lightHydrate,
        withTotal: state.withTotal,
        limit: 5,
        offset: 0,
      });
      assertSearchShape(result, state, 'rowsForCards');
    } catch (error) {
      if (violations.length < 5) {
        violations.push(`${error.message}`);
      }
    }
    checked += 1;
  }
  assert.equal(checked, QUERIES.length * PRODUCT_TYPES.length * SEARCH_ONLY.length
    * PRINT_LANGS.length * MEILI.length * LIGHT_HYDRATE.length * WITH_TOTAL.length,
    'enumeration size is pinned — a trimmed model must fail loudly');
  assert.ok(checked >= 8000, `matrix too small to be meaningful: ${checked}`);
  assert.deepEqual(violations, [], `search shape invariant violations:\n${violations.join('\n')}`);
});

test('engine-level matrix: rowsForSearchTerm obeys the same shape invariant', async () => {
  const { engine } = assemble();
  const violations = [];
  let checked = 0;
  for (const query of QUERIES) {
    for (const printLanguage of PRINT_LANGS) {
      for (const meili of MEILI) {
        for (const lightHydrate of LIGHT_HYDRATE) {
          for (const withTotal of WITH_TOTAL) {
            globalThis.__matrixMeili = meili;
            const state = { query, printLanguage, meili, lightHydrate, withTotal };
            try {
              const result = await engine.rowsForSearchTerm(query, 5, 0, 'en', null, null, {
                printLanguage,
                lightHydrate,
                withTotal,
              });
              assertSearchShape(result, state, 'rowsForSearchTerm');
            } catch (error) {
              if (violations.length < 5) violations.push(error.message);
            }
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, QUERIES.length * PRINT_LANGS.length * MEILI.length
    * LIGHT_HYDRATE.length * WITH_TOTAL.length);
  assert.deepEqual(violations, [], `engine shape invariant violations:\n${violations.join('\n')}`);
});

test('witness: "102 spheal" Singles (productType=card, Meili, withTotal) returns real rows', async () => {
  const { cards } = assemble();
  globalThis.__matrixMeili = true;
  const result = await cards.rowsForCards({
    query: '102 spheal',
    productType: 'card',
    withTotal: true,
    limit: 5,
    searchLanguage: 'en',
    lightHydrate: true,
    printLanguage: 'all',
  });
  assert.ok(Array.isArray(result.rows));
  assert.equal(result.total, 7);
  // The Meili window keeps rows whose product_type matches the Singles chip.
  for (const row of result.rows) {
    assert.equal(String(row.product_type || ''), 'card');
  }
});
