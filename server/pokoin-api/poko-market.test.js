'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'poko-market.js');

// Marketplace rows the SQL stub routes to. `seller_uid` is planted on purpose:
// the handler DTO must never forward it, so the privacy test fails loudly if
// the select lists ever widen without care.
const FIXTURE_CARD_ROW = {
  card_id: '246912',
  name: 'Raichu ex',
  set_name: 'EX Team Rocket Returns',
  artist: 'Ken Sugimori',
  item_kind: 'single',
  card_number: '8/109',
};

function makeDb(stubs) {
  return async function marketplaceQuery(sql, params = []) {
    stubs.queries.push({ sql, params });
    // Order matters: tool-specific tables first, generic card-row lookup last.
    const rows = (table) => stubs[table] ?? [];
    if (/marketplace_card_weights/.test(sql)) return { rows: rows('weightRows') };
    if (/group by artist/.test(sql)) return { rows: stubs.artistRows ?? [{ artist: 'Yuka Morii', cards: 42 }] };
    if (/order by s\.name\s+limit \$2/.test(sql)) return { rows: rows('collectionCards') };
    if (/cardtrader_sold_daily/.test(sql) && /group by blueprint_id/.test(sql)) return { rows: rows('collectionSold') };
    if (/distinct on \(blueprint_id\)/.test(sql)) return { rows: rows('collectionAsks') };
    if (/cardtrader_sold_daily/.test(sql)) return { rows: rows('soldRows') };
    if (/cardtrader_blueprint_daily_analytics/.test(sql)) return { rows: rows('askRows') };
    if (/limit 7/.test(sql) || (/limit 1/.test(sql) && /card_id = \$1/.test(sql))) {
      return { rows: [stubs.cardRow || FIXTURE_CARD_ROW] };
    }
    return { rows: [] };
  };
}

function loadHandler(dbStub) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return { marketplaceQuery: dbStub }; // dbStub returns pg-shaped { rows }
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.POKO_MARKET_SERVICE_TOKEN || 'tok'}` },
    body: {},
    ...overrides,
  };
}

const FORBIDDEN = /seller_uid|buyer_uid|email|firebase|address|phone|session|password/i;

// The handler reads the token at request time; keep a test token set for the
// whole file (the refusal test toggles it and always restores this value).
process.env.POKO_MARKET_SERVICE_TOKEN = 'tok';

// The handler module requires './_marketplace_db', which only exists on the Pi
// runtime. Load it once through the same Module._load stub the handler tests
// use, and reuse the pure _test helpers from that instance everywhere.
const T = (function loadTestHelpers() {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return { marketplaceQuery: async () => [] };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(TARGET)._test;
  } finally {
    Module._load = originalLoad;
  }
})();

test('condition normalization maps casual terms and keeps vague wording vague', () => {
  assert.equal(T.normalizeCondition('near mint').primary, 'NM');
  assert.equal(T.normalizeCondition('pretty clean').primary, 'NM');
  assert.equal(T.normalizeCondition('lightly played').primary, 'SP');
  assert.equal(T.normalizeCondition('moderately played').primary, 'MP');
  assert.equal(T.normalizeCondition('heavily played').primary, 'PL');
  assert.equal(T.normalizeCondition('really damaged').primary, 'Poor');

  const vague = T.normalizeCondition("a bit damaged");
  assert.equal(vague.vague, true);
  assert.equal(vague.primary, 'MP');
  assert.deepEqual(vague.alternatives, ['PL', 'Poor']);

  const unknown = T.normalizeCondition('banana');
  assert.equal(unknown.matched, false);
  assert.equal(unknown.primary, 'NM');
});

test('language normalization resolves common names into CardTrader codes', () => {
  assert.equal(T.normalizeLanguage('Italian').code, 'IT');
  assert.equal(T.normalizeLanguage('giapponese').code, 'JP');
  assert.equal(T.normalizeLanguage('English').code, 'EN');
  assert.equal(T.normalizeLanguage('klingon').code, 'EN');
});

test('like patterns escape wildcards; fuzzy artist allows only [a-z0-9]', () => {
  assert.equal(T.escapeLike('rai%chu_'), 'rai\\%chu\\_');
  assert.equal(T.fuzzyArtistPattern('Yuka Morii'), '%y%u%k%a%m%o%r%i%i%');
  assert.equal(T.fuzzyArtistPattern('Yukamori'), '%y%u%k%a%m%o%r%i%');
  assert.equal(T.fuzzyArtistPattern("'); drop table x;--"), '%d%r%o%p%t%a%b%l%e%x%');
});

test('blueprint ids derive only from even public card ids', () => {
  assert.equal(T.blueprintIdFromCardId('246912'), 123456);
  assert.equal(T.blueprintIdFromCardId('246913'), null);
  assert.equal(T.blueprintIdFromCardId('abc'), null);
});

test('confidence and price strategies degrade honestly with sample size', () => {
  assert.equal(T.confidenceForSample(0), 'none');
  assert.equal(T.confidenceForSample(2), 'low');
  assert.equal(T.confidenceForSample(6), 'medium');
  assert.equal(T.confidenceForSample(30), 'high');

  const summary = { median: 34, p25: 30, p75: 37, confidence: 'high', sampleSize: 14 };
  const strategies = T.priceStrategies(summary, { min: 36 });
  assert.equal(strategies.quickSale.price, 30);
  assert.equal(strategies.market.price, 34);
  assert.equal(strategies.patient.price, 37);

  assert.equal(T.priceStrategies({ ...summary, confidence: 'low' }, null), null);
  assert.equal(T.priceStrategies(null, null), null);
});

test('liquidity bands are deterministic and labelled', () => {
  const bands = T.liquidityBands({ daysOfSupply: 10, soldQty7d: 5, listedNow: 4 });
  assert.deepEqual(bands, {
    lowDays: 4,
    typicalDays: 10,
    highDays: 25,
    methodology: 'days_of_supply from marketplace_card_weights',
    confidence: 'medium',
  });
  const heuristic = T.liquidityBands({ daysOfSupply: null, soldQty7d: 7, listedNow: 7 });
  assert.equal(heuristic.typicalDays, 7);
  assert.equal(heuristic.confidence, 'low');
  assert.equal(T.liquidityBands({ daysOfSupply: null, soldQty7d: 0, listedNow: 0 }), null);
});

test('handler refuses unconfigured, unauthorized, GET and unknown tools', async () => {
  const queries = [];
  const handler = loadHandler(makeDb({ queries }));
  process.env.POKO_MARKET_SERVICE_TOKEN = '';

  let res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 503);

  process.env.POKO_MARKET_SERVICE_TOKEN = 'tok';
  res = makeRes();
  await handler(makeReq({ headers: { authorization: 'Bearer wrong' } }), res);
  assert.equal(res.statusCode, 401);

  res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);

  res = makeRes();
  await handler(makeReq({ body: { tool: 'drop_table' } }), res);
  assert.equal(res.statusCode, 400);

  // Fallback: POKONTACT_SERVICE_TOKEN (already in the Pi container env) is the
  // same secret per docs/poko-handoff.md and authorizes identically.
  const prevMarket = process.env.POKO_MARKET_SERVICE_TOKEN;
  const prevPokontact = process.env.POKONTACT_SERVICE_TOKEN;
  try {
    process.env.POKO_MARKET_SERVICE_TOKEN = '';
    process.env.POKONTACT_SERVICE_TOKEN = 'pokontact-tok';
    res = makeRes();
    await handler(makeReq({ method: 'GET', headers: { authorization: 'Bearer pokontact-tok' } }), res);
    assert.equal(res.statusCode, 405); // authorized (past 401); POST-only check fires
    res = makeRes();
    await handler(makeReq({ headers: { authorization: 'Bearer tok' }, body: { tool: 'market_snapshot' } }), res);
    assert.equal(res.statusCode, 401);
  } finally {
    process.env.POKO_MARKET_SERVICE_TOKEN = prevMarket ?? 'tok';
    if (prevPokontact === undefined) delete process.env.POKONTACT_SERVICE_TOKEN;
    else process.env.POKONTACT_SERVICE_TOKEN = prevPokontact;
  }
});

test('resolve_card returns catalog candidates only and marks ambiguity', async () => {
  const queries = [];
  const handler = loadHandler(makeDb({ queries }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'resolve_card', params: { query: 'old Raichu ex' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.candidates[0].name, 'Raichu ex');

  // Fuzzy user text travels as a parameter, wildcards escaped, never inline SQL.
  const resolveQuery = queries.find((q) => /limit 7/.test(q.sql));
  assert.ok(resolveQuery, 'resolve query captured');
  const patterns = resolveQuery.params.filter((pt) => typeof pt === 'string');
  if (!patterns.some((pt) => pt.includes('raichu'))) {
    assert.fail(`token patterns missing raichu: ${JSON.stringify(resolveQuery.params)}`);
  }
  assert.ok(patterns.every((pt) => pt.startsWith('%')));
  assert.ok(!resolveQuery.sql.includes('Raichu'));

  const handler3 = loadHandler(async (sql, params = []) => {
    if (/limit 7/.test(sql)) {
      return { rows: [
        FIXTURE_CARD_ROW,
        { ...FIXTURE_CARD_ROW, card_id: '246914', name: 'Raichu', set_name: 'Base Set' },
        { ...FIXTURE_CARD_ROW, card_id: '246916', name: 'Raichu ex', set_name: 'Deoxys' },
      ] };
    }
    return { rows: [] };
  });
  const res3 = makeRes();
  await handler3(makeReq({ body: { tool: 'resolve_card', params: { query: 'Raichu' } } }), res3);
  assert.equal(res3.body.status, 'ambiguous');
  assert.equal(res3.body.candidates.length, 3);
  assert.match(res3.body.note, /which one they mean/i);
});

test('card_quote reports sold estimate, asks and strategies without inventing data', async () => {
  const queries = [];
  const handler = loadHandler(makeDb({
    queries,
    soldRows: [{
      sold_qty: 14,
      p25_daily: 30,
      median_daily: 34,
      p75_daily: 37,
      last_sale_day: '2026-09-20',
    }],
    askRows: [{ min_price_pkn: 36, median_price_pkn: 41, observed_day: '2026-09-26' }],
    weightRows: [{ sold_qty_7d: 2, listed_now: 5, sell_through: 0.4, days_of_supply: 12, demand_score: 3, updated_at: new Date(Date.now() - 3_600_000).toISOString() }],
  }));
  const res = makeRes();
  await handler(makeReq({
    body: { tool: 'card_quote', params: { query: 'Raichu ex', condition: 'near mint', language: 'English' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quotes[0].estimate.median, 34);
  assert.equal(res.body.quotes[0].estimate.confidence, 'high');
  assert.equal(res.body.quotes[0].currentAsk.min, 36);
  assert.equal(res.body.quotes[0].strategies.market.price, 34);
  assert.equal(res.body.quotes[0].liquidity.typicalDays, 12);

  // Zero-sales fixture: asking price only, no fabricated sold median.
  const handler2 = loadHandler(makeDb({ queries: [], soldRows: [], askRows: [{ min_price_pkn: 48, median_price_pkn: 55, observed_day: '2026-09-26' }] }));
  const res2 = makeRes();
  await handler2(makeReq({ body: { tool: 'card_quote', params: { cardId: '246912' } } }), res2);
  assert.equal(res2.body.quotes[0].askingPriceOnly, true);
  assert.equal(res2.body.quotes[0].estimate, null);
  assert.equal(res2.body.quotes[0].strategies, null);
  assert.equal(res2.body.quotes[0].currentAsk.min, 48);
});

test('vague condition wording quotes a range instead of claiming a grade', async () => {
  const soldByCall = [];
  const handler = loadHandler(async (sql, params = []) => {
    if (/cardtrader_sold_daily/.test(sql)) {
      soldByCall.push(params[1]);
      return { rows: [{ sold_qty: 6, p25_daily: 20, median_daily: 24, p75_daily: 28, last_sale_day: '2026-09-18' }] };
    }
    if (/cardtrader_blueprint_daily_analytics/.test(sql)) return { rows: [{ min_price_pkn: 26, median_price_pkn: 30, observed_day: '2026-09-26' }] };
    if (/marketplace_card_weights/.test(sql)) return { rows: [] };
    if (/limit 1/.test(sql) || /limit 7/.test(sql)) return { rows: [FIXTURE_CARD_ROW] };
    return { rows: [] };
  });
  const res = makeRes();
  await handler(makeReq({
    body: { tool: 'card_quote', params: { cardId: '246912', condition: 'a bit damaged' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.filters.conditionVague, true);
  assert.match(res.body.conditionNote, /MP and PL/);
  assert.deepEqual(res.body.quotes.map((q) => q.condition), ['MP', 'PL']);
});

test('collection_quote resolves fuzzy artists, reports coverage honestly', async () => {
  const cards = Array.from({ length: 4 }, (_, i) => ({
    ...FIXTURE_CARD_ROW,
    card_id: String(246912 + i * 2),
    name: `Morii Card ${i + 1}`,
  }));
  const handler = loadHandler(makeDb({
    queries: [],
    artistRows: [{ artist: 'Yuka Morii', cards: cards.length }],
    collectionCards: cards,
    collectionSold: [
      { blueprint_id: 123456, sold_qty: 9, median_daily: 10 },
      { blueprint_id: 123458, sold_qty: 2, median_daily: 5 },
    ],
    collectionAsks: [
      { blueprint_id: 123456, min_price_pkn: 12, observed_day: '2026-09-26' },
      { blueprint_id: 123457, min_price_pkn: 7, observed_day: '2026-09-26' },
      { blueprint_id: 123458, min_price_pkn: 3, observed_day: '2026-09-26' },
    ],
  }));
  const res = makeRes();
  await handler(makeReq({
    body: { tool: 'collection_quote', params: { artist: 'Yukamori' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.artist, 'Yuka Morii');
  assert.equal(res.body.cardsTotal, 4);
  assert.equal(res.body.cardsPriced, 3);
  assert.equal(res.body.cardsUnpriced, 1);
  assert.equal(res.body.coveragePct, 75);
  assert.ok(res.body.estimatedMarketValue > 0);
  assert.match(res.body.note, /different metrics/);
  assert.equal(res.body.mostExpensive[0].name, 'Morii Card 1');
  assert.equal(res.body.lowestLiquidity[0].soldQty90d, 0);

  // Ambiguous artists are never silently resolved.
  const handler2 = loadHandler(makeDb({
    queries: [],
    artistRows: [
      { artist: 'Yuka Morii', cards: 42 },
      { artist: 'Yuka moriz', cards: 3 },
    ],
  }));
  const res2 = makeRes();
  await handler2(makeReq({ body: { tool: 'collection_quote', params: { artist: 'Yukamori' } } }), res2);
  assert.equal(res2.body.status, 'ambiguous');
  assert.equal(res2.body.artists.length, 2);
});

test('default collection filters are NM / EN / one copy each', async () => {
  const queries = [];
  const handler = loadHandler(makeDb({ queries, collectionCards: [FIXTURE_CARD_ROW] }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'collection_quote', params: { artist: 'Yuka Morii' } } }), res);
  assert.deepEqual(res.body.filters, { condition: 'NM', language: 'EN', quantityPerCard: 1 });
});

test('stale weights fall back to fresh sold data instead of quoting old bands', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    // 2026-09-13-style stale snapshot: must NOT be used for days_of_supply.
    weightRows: [{ sold_qty_7d: 2, listed_now: 5, sell_through: 0.4, days_of_supply: 12, updated_at: '2026-09-13T11:37:51Z' }],
    soldRows: [{ sold_qty: 28, p25_daily: 30, median_daily: 34, p75_daily: 37, last_sale_day: '2026-09-25' }],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_liquidity', params: { cardId: '246912' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.liquidity.source, 'sold_daily_fallback');
  assert.equal(res.body.liquidity.confidence, 'low');
  assert.equal(res.body.weights.daysOfSupply, 12);
});

test('DTO never carries private columns even when fixtures contain them', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: [{ sold_qty: 14, p25_daily: 30, median_daily: 34, p75_daily: 37, last_sale_day: '2026-09-20', seller_uid: 'SELLER-SECRET' }],
    askRows: [{ min_price_pkn: 36, median_price_pkn: 41, observed_day: '2026-09-26', buyer_uid: 'BUYER-SECRET' }],
    weightRows: [{ sold_qty_7d: 2, listed_now: 5, sell_through: 0.4, days_of_supply: 12, seller_uid: 'SNEAKY', updated_at: 'now' }],
    cardRow: { ...FIXTURE_CARD_ROW, email: 'secret@example.com' },
  }));
  const res = makeRes();
  await handler(makeReq({
    body: { tool: 'card_quote', params: { cardId: '246912' } },
  }), res);
  const serialized = JSON.stringify(res.body);
  assert.ok(!FORBIDDEN.test(serialized), `privacy leak in DTO: ${serialized.match(FORBIDDEN)}`);
});

test('market_snapshot returns public aggregates only', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    weightRows: [{
      card_id: '246912', sold_qty_7d: 9, listed_now: 3, sell_through: 0.75,
      median_sold_eur: 33.5, sold_value_eur_7d: 301.5,
      name: 'Raichu ex', set_name: 'EX TRR', artist: 'Ken Sugimori',
    }],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'market_snapshot', params: { limit: 10 } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cards[0].soldQty7d, 9);
  assert.equal(res.body.cards[0].medianSoldEur, 33.5);
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));
});

test('card_quote anchors today and dated windows for relative time expressions', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: [{ sold_qty: 14, p25_daily: 30, median_daily: 34, p75_daily: 37, last_sale_day: '2026-09-20' }],
    askRows: [{ min_price_pkn: 36, median_price_pkn: 41, observed_day: '2026-09-26' }],
    weightRows: [{ sold_qty_7d: 2, listed_now: 5, sell_through: 0.4, days_of_supply: 12, updated_at: new Date().toISOString() }],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '246912' } } }), res);
  assert.equal(res.body.today, new Date().toISOString().slice(0, 10));
  assert.equal(res.body.window.soldDays, 90);
  const expectedFrom = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(res.body.window.from, expectedFrom);
});
