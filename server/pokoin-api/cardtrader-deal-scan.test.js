'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'cardtrader-deal-scan.js');

function loadHandler(dbStub, fetchStub) {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return { marketplaceQuery: dbStub };
    }
    return originalLoad(request, parent, isMain);
  };
  if (fetchStub) globalThis.fetch = fetchStub;
  try {
    const mod = require(TARGET);
    Module._load = originalLoad;
    const handler = typeof mod === 'function' ? mod : null;
    if (!handler) throw new Error('cardtrader-deal-scan export is not a function');
    handler.restore = () => {
      globalThis.fetch = originalFetch;
      delete require.cache[TARGET];
    };
    return handler;
  } catch (error) {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    throw error;
  }
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const T = (function loadHelpers() {
  const loaded = loadHandler(async () => ({ rows: [] }));
  const helpers = loaded._test;
  loaded.restore();
  return helpers;
})();

test('parseSellerInput accepts username and CardTrader profile URL', () => {
  assert.deepEqual(T.parseSellerInput({ seller: 'olivefrancesco10' }), {
    ok: true,
    username: 'olivefrancesco10',
  });
  assert.equal(
    T.parseSellerInput({
      url: 'https://www.cardtrader.com/en-US/users/olivefrancesco10',
    }).username,
    'olivefrancesco10',
  );
  assert.equal(
    T.parseSellerInput({
      url: 'https://www.cardtrader.com/en/users/olivefrancesco10?foo=1',
    }).username,
    'olivefrancesco10',
  );
  assert.equal(T.parseSellerInput({ seller: '' }).ok, false);
  assert.equal(T.parseSellerInput({ url: 'https://example.com/x' }).ok, false);
});

test('normalizeCondition maps CT long forms to sold codes', () => {
  assert.equal(T.normalizeCondition('Near Mint'), 'NM');
  assert.equal(T.normalizeCondition('Slightly Played'), 'SP');
  assert.equal(T.normalizeCondition('Played'), 'MP');
  assert.equal(T.normalizeCondition('Moderately Played'), 'MP');
  assert.equal(T.normalizeCondition('Heavily Played'), 'PL');
  assert.equal(T.normalizeCondition('Poor'), 'Poor');
});

test('normalizeLanguage maps snapshot codes including kr and zh-CN', () => {
  assert.equal(T.normalizeLanguage('it'), 'IT');
  assert.equal(T.normalizeLanguage('en'), 'EN');
  assert.equal(T.normalizeLanguage('jp'), 'JP');
  assert.equal(T.normalizeLanguage('kr'), 'KO');
  assert.equal(T.normalizeLanguage('zh-CN'), 'ZH');
  assert.equal(T.normalizeLanguage('zh-TW'), 'ZHT');
});

test('classifyDeals keeps facet flags and never promotes no_sold_match', () => {
  const out = T.classifyDeals([
    {
      blueprint_id: '1',
      card_id: '2',
      card_name: 'Cyndaquil',
      expansion_name: 'ex unseen forces',
      card_number: '54/115',
      condition_raw: 'Poor',
      condition_code: 'Poor',
      language_raw: 'it',
      language_code: 'IT',
      reverse: false,
      first_edition: false,
      graded: false,
      ask_eur: 0.5,
      quantity: 1,
      sold_median_eur: 2.0,
      live_cheapest_eur: 0.5,
      live_median_eur: 1.5,
      live_listing_count: 10,
      sold_qty_90d: 5,
      last_sold_day: '2026-09-25',
      flag: 'cheap_vs_sold',
      sold_over_ask: 4,
      ask_over_sold: 0.25,
    },
    {
      blueprint_id: '9',
      card_id: null,
      card_name: 'Bulk',
      expansion_name: 'x',
      card_number: '',
      condition_raw: 'Near Mint',
      condition_code: 'NM',
      language_raw: 'en',
      language_code: 'EN',
      reverse: false,
      first_edition: false,
      graded: false,
      ask_eur: 1,
      quantity: 1,
      sold_median_eur: null,
      live_cheapest_eur: 1,
      live_median_eur: 1,
      live_listing_count: 5,
      sold_qty_90d: 0,
      last_sold_day: null,
      flag: 'no_sold_match',
      sold_over_ask: null,
      ask_over_sold: null,
    },
  ]);
  assert.equal(out.cheap.length, 1);
  assert.equal(out.cheap[0].cardName, 'Cyndaquil');
  assert.equal(out.cheap[0].condition, 'Poor');
  assert.equal(out.cheap[0].language, 'IT');
  assert.equal(out.unmatched, 1);
  assert.equal(out.expensive.length, 0);
});

test('unauthorized without DEAL_SCAN_TOKEN bearer', async () => {
  process.env.DEAL_SCAN_TOKEN = 'secret-deal';
  const handler = loadHandler(async () => ({ rows: [] }));
  try {
    const res = mockRes();
    await handler({
      method: 'GET',
      url: '/api/cardtrader-deal-scan?seller=olivefrancesco10',
      headers: {},
    }, res);
    assert.equal(res.statusCode, 401);
  } finally {
    handler.restore();
  }
});

test('missing seller returns 404 after CT + snapshot miss', async () => {
  process.env.DEAL_SCAN_TOKEN = 'secret-deal';
  const handler = loadHandler(
    async () => ({ rows: [] }),
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
  );
  try {
    const res = mockRes();
    await handler({
      method: 'GET',
      url: '/api/cardtrader-deal-scan?seller=nobody-here-xyz',
      headers: { authorization: 'Bearer secret-deal' },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not found/i);
  } finally {
    handler.restore();
  }
});

test('resolves CT user id when snapshot name differs and returns Psychic Energy cheap deal', async () => {
  process.env.DEAL_SCAN_TOKEN = 'secret-deal';
  const handler = loadHandler(
    async (sql) => {
      // Resolve: exact snapshot name miss, then id hit after CT fetch.
      if (/seller_account_name = \$1/i.test(sql)) return { rows: [] };
      if (/as quantity_sum/i.test(sql) && /seller_account_id = \$1/i.test(sql) && !/distinct on/i.test(sql)) {
        return {
          rows: [{
            account_id: '433468',
            snapshot_name: 'Gotta-collect_em-all',
            listing_count: 2836,
            quantity_sum: 3462,
          }],
        };
      }
      // Step 1: seller listings (+ catalog join).
      if (/distinct on/i.test(sql) && /marketplace_search_candidates/i.test(sql)) {
        return {
          rows: [{
            blueprint_id: '121202',
            ask_eur: 5.11,
            quantity: 1,
            condition_raw: 'Played',
            language_raw: 'it',
            reverse: false,
            first_edition: false,
            graded: false,
            card_name: 'Psychic Energy',
            expansion_name: 'heartgold soulsilver',
            card_number: '119/123',
            card_id: '242404',
          }],
        };
      }
      // Step 2: live book median from snapshots.
      if (/percentile_cont\(0\.5\)/i.test(sql) && /cardtrader_market_listing_snapshots/i.test(sql)) {
        return {
          rows: [{
            blueprint_id: '121202',
            live_cheapest_eur: 5.11,
            live_median_eur: 20.27,
            live_listing_count: 27,
          }],
        };
      }
      // Step 3: facet sold medians (MP|IT only — cross-facet would not match).
      if (/cardtrader_sold_daily/i.test(sql) && /sold_days/i.test(sql)) {
        return {
          rows: [{
            blueprint_id: '121202',
            condition_code: 'MP',
            language_code: 'IT',
            reverse: false,
            first_edition: false,
            graded: false,
            sold_median_eur: 18.77,
            sold_qty_90d: 5,
            sold_day_rows: 3,
            last_sold_day: '2026-09-25',
          }],
        };
      }
      return { rows: [] };
    },
    async () => ({
      ok: true,
      json: async () => ({ user: { id: 433468, username: 'olivefrancesco10' } }),
    }),
  );
  try {
    const res = mockRes();
    await handler({
      method: 'GET',
      url: '/api/cardtrader-deal-scan?seller=olivefrancesco10',
      headers: { authorization: 'Bearer secret-deal' },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.match, 'facet_perfect');
    assert.equal(res.body.seller.accountId, '433468');
    assert.equal(res.body.seller.snapshotName, 'Gotta-collect_em-all');
    assert.equal(res.body.deals.cheap.length, 1);
    assert.equal(res.body.deals.cheap[0].cardName, 'Psychic Energy');
    assert.equal(res.body.deals.cheap[0].language, 'IT');
    assert.equal(res.body.deals.cheap[0].condition, 'MP');
    assert.ok(res.body.deals.cheap[0].soldOverAsk >= 3);
  } finally {
    handler.restore();
  }
});

test('facet join rejects cross-condition sold matches (Poor IT ≠ NM EN)', async () => {
  process.env.DEAL_SCAN_TOKEN = 'secret-deal';
  const handler = loadHandler(
    async (sql) => {
      if (/seller_account_name = \$1/i.test(sql)) {
        return {
          rows: [{
            account_id: '1',
            snapshot_name: 'tester',
            listing_count: 1,
            quantity_sum: 1,
          }],
        };
      }
      if (/distinct on/i.test(sql)) {
        return {
          rows: [{
            blueprint_id: '99',
            ask_eur: 0.5,
            quantity: 1,
            condition_raw: 'Poor',
            language_raw: 'it',
            reverse: false,
            first_edition: false,
            graded: false,
            card_name: 'Cyndaquil',
            expansion_name: 'ex unseen forces',
            card_number: '54/115',
            card_id: '100',
          }],
        };
      }
      if (/percentile_cont\(0\.5\)/i.test(sql) && /cardtrader_market_listing_snapshots/i.test(sql)) {
        return {
          rows: [{
            blueprint_id: '99',
            live_cheapest_eur: 0.5,
            live_median_eur: 2.0,
            live_listing_count: 10,
          }],
        };
      }
      if (/cardtrader_sold_daily/i.test(sql)) {
        // Only NM EN sold history — must NOT match Poor IT listing.
        return {
          rows: [{
            blueprint_id: '99',
            condition_code: 'NM',
            language_code: 'EN',
            reverse: false,
            first_edition: false,
            graded: false,
            sold_median_eur: 5.0,
            sold_qty_90d: 20,
            sold_day_rows: 5,
            last_sold_day: '2026-09-20',
          }],
        };
      }
      return { rows: [] };
    },
  );
  try {
    const res = mockRes();
    await handler({
      method: 'GET',
      url: '/api/cardtrader-deal-scan?seller=tester',
      headers: { authorization: 'Bearer secret-deal' },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.deals.cheap.length, 0);
    assert.equal(res.body.deals.expensive.length, 0);
    assert.equal(res.body.unmatchedCount, 1);
  } finally {
    handler.restore();
  }
});
