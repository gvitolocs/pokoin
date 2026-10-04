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
  ct_id: '123456',
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
    if (/with art as/.test(sql)) return { rows: rows('artistCardRows') };
    if (/pokoin_pokemon_expansions/.test(sql)) return { rows: rows('expansionRows') };
    if (/with cands as/.test(sql)) return { rows: rows('moverRows') };
    if (/with cards as/.test(sql)) return { rows: rows('setRows') };
    if (/with recent as/.test(sql)) return { rows: rows('recentRows') };
    if (/cardtrader_market_listing_snapshots/.test(sql)) return { rows: rows('liveRows') };
    if (/with sold as/.test(sql)) return { rows: rows('sellerRows') };
    if (/marketplace_card_weights/.test(sql)) return { rows: rows('weightRows') };
    if (/group by artist/.test(sql)) return { rows: stubs.artistRows ?? [{ artist: 'Yuka Morii', cards: 42 }] };
    if (/order by s\.name\s+limit \$2/.test(sql)) return { rows: rows('collectionCards') };
    if (/cardtrader_sold_daily/.test(sql) && /group by blueprint_id/.test(sql)) return { rows: rows('collectionSold') };
    if (/distinct on \(blueprint_id\)/.test(sql)) return { rows: rows('collectionAsks') };
    if (/marketplace_card_ocr/.test(sql)) return { rows: rows('ocrRows') };
    if (/cardtrader_sold_daily/.test(sql)) return { rows: rows('soldRows') };
    if (/cardtrader_blueprint_daily_analytics/.test(sql)) return { rows: rows('askRows') };
    if (/limit 24/.test(sql) || /limit 7/.test(sql) || (/limit 1/.test(sql) && /card_id = \$1/.test(sql))) {
      return { rows: [stubs.cardRow || FIXTURE_CARD_ROW] };
    }
    return { rows: [] };
  };
}

function loadHandler(dbStub, priceHistoryStub) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_game') return { currentGame: () => 'pokemon' };
    if (request === './_card_price_history') {
      const sources = originalLoad(request, parent, isMain);
      return { ...sources, readCardPriceHistory: priceHistoryStub || (async () => ({
        cardtrader: sources.cardtraderSource([]), tcgplayer: sources.tcgplayerSource([]),
      })) };
    }
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

// One cardtrader_sold_daily day-slice row (standard NM English by default).
function soldDay(overrides = {}) {
  const median = overrides.median_pkn ?? 100;
  return {
    observed_day: '2026-09-20',
    condition: 'NM',
    language: 'EN',
    reverse: false,
    first_edition: false,
    graded: false,
    sold_qty: 1,
    median_pkn: median,
    min_pkn: median,
    max_pkn: median,
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
    if (request === './_marketplace_game') return { currentGame: () => 'pokemon' };
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

test('blueprint IDs require explicit catalog identity, including nonarithmetic public IDs', () => {
  assert.equal(T.blueprintIdFromCatalogRow({card_id:'777',ct_id:'88'}), 88);
  assert.equal(T.blueprintIdFromCatalogRow({card_id:'246912'}), null);
  assert.equal(T.blueprintIdFromCatalogRow({card_id:'777',ct_id:'bad'}), null);
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

  assert.equal(strategies.market.expectedTime, '1-3w');
  assert.match(strategies.expectedTimeBasis, /generic/);

  // Raikou ex regression: liquidity 1 / 3 / 8 days must not read as weeks.
  const banded = T.priceStrategies(summary, null, { lowDays: 1, typicalDays: 3, highDays: 8 });
  assert.equal(banded.quickSale.expectedTime, '1-3d');
  assert.equal(banded.market.expectedTime, '3-8d');
  assert.equal(banded.patient.expectedTime, '8-16d');
  assert.equal(banded.expectedTimeBasis, 'card liquidity bands');
  const slow = T.priceStrategies(summary, null, { lowDays: 10, typicalDays: 30, highDays: 75 });
  assert.equal(slow.market.expectedTime, '4-11w');

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
  const resolveQuery = queries.find((q) => /limit 24/.test(q.sql));
  assert.ok(resolveQuery, 'resolve query captured');
  const patterns = resolveQuery.params.filter((pt) => typeof pt === 'string');
  if (!patterns.some((pt) => pt.includes('raichu'))) {
    assert.fail(`token patterns missing raichu: ${JSON.stringify(resolveQuery.params)}`);
  }
  assert.ok(patterns.every((pt) => pt.startsWith('%')));
  assert.ok(!resolveQuery.sql.includes('Raichu'));

  const handler3 = loadHandler(async (sql, params = []) => {
    if (/limit 24/.test(sql)) {
      return { rows: [
        { ...FIXTURE_CARD_ROW, version: 'v1' },
        { ...FIXTURE_CARD_ROW, card_id: '246914', name: 'Raichu', set_name: 'Base Set', version: 'v2' },
        { ...FIXTURE_CARD_ROW, card_id: '246916', name: 'Raichu ex', set_name: 'Deoxys', version: 'v3' },
        // Same artwork as first — collapsed.
        { ...FIXTURE_CARD_ROW, card_id: '999999', name: 'Raichu ex', set_name: 'Half Deck', version: 'v1' },
      ] };
    }
    return { rows: [] };
  });
  const res3 = makeRes();
  await handler3(makeReq({ body: { tool: 'resolve_card', params: { query: 'Raichu' } } }), res3);
  assert.equal(res3.body.status, 'ambiguous');
  assert.equal(res3.body.candidates.length, 3);
  assert.equal(res3.body.sameArtworkCollapsed, 1);
  assert.match(res3.body.note, /which one they mean/i);
});

test('resolve_card maps a set code alias onto the expansion and drops the asking price', async () => {
  const queries = [];
  const handler = loadHandler(async (sql, params = []) => {
    queries.push({ sql, params });
    if (/marketplace_expansion_aliases/.test(sql)) {
      return { rows: params[0] === '30c' ? [{ expansion_name: '30th Celebration' }] : [] };
    }
    if (/limit 24/.test(sql)) {
      return { rows: [{
        card_id: '826440', ct_id: '1', name: 'Solgaleo GX', set_name: '30th Celebration',
        artist: '', item_kind: 'single', version: 'sum89', card_number: 'SUM 89',
      }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await handler(makeReq({
    body: { tool: 'resolve_card', params: { query: 'Solgaleo GX (30C SUM 89) 70kr' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.candidates[0].cardId, '826440');
  assert.equal(res.body.candidates[0].setName, '30th Celebration');

  const resolveQuery = queries.find((q) => /limit 24/.test(q.sql));
  assert.match(resolveQuery.sql, /s\.set_name = \$/);
  assert.ok(resolveQuery.params.includes('30th Celebration'));
  assert.ok(resolveQuery.params.some((value) => String(value).includes('solgaleo')));
  assert.ok(resolveQuery.params.some((value) => String(value).includes('sum')));
  assert.ok(resolveQuery.params.some((value) => String(value).includes('89')));
  assert.ok(resolveQuery.params.every((value) => !String(value).toLowerCase().includes('30c')));
  assert.ok(resolveQuery.params.every((value) => !String(value).toLowerCase().includes('70')));

  // A digit-less name must not be rewritten through the "mew" → 151 alias.
  const plain = [];
  const plainHandler = loadHandler(async (sql, params = []) => {
    plain.push({ sql, params });
    if (/limit 24/.test(sql)) return { rows: [FIXTURE_CARD_ROW] };
    return { rows: [] };
  });
  const plainRes = makeRes();
  await plainHandler(makeReq({ body: { tool: 'resolve_card', params: { query: 'Mew ex' } } }), plainRes);
  assert.equal(plain.some((q) => /marketplace_expansion_aliases/.test(q.sql)), false);
  assert.equal(/set_name =/.test(plain.find((q) => /limit 24/.test(q.sql)).sql), false);
});

test('card_quote reports sold estimate, asks and strategies without inventing data', async () => {
  const queries = [];
  const handler = loadHandler(makeDb({
    queries,
    soldRows: [soldDay({ sold_qty: 14, median_pkn: 34, min_pkn: 30, max_pkn: 37 })],
    askRows: [{ min_price_pkn: 36, median_price_pkn: 41, observed_day: '2026-09-26' }],
    weightRows: [{ sold_qty_7d: 2, listed_now: 5, sell_through: 0.4, days_of_supply: 12, demand_score: 3, updated_at: new Date(Date.now() - 3_600_000).toISOString() }],
  }));
  const res = makeRes();
  await handler(makeReq({
    body: { tool: 'card_quote', params: { query: 'Raichu ex', condition: 'near mint', language: 'English' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.priceUnit, 'PKN');
  assert.equal(res.body.pknEurRate, 0.005);
  assert.equal(res.body.quotes[0].estimate.median, 34);
  assert.equal(res.body.quotes[0].estimate.currency, 'PKN');
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

test('card_quote keeps dated CardTrader and USD analytics without sold comps or arithmetic IDs', async () => {
  const { cardtraderSource, tcgplayerSource } = require('./_card_price_history');
  const queries = [], historyCalls = [];
  const handler = loadHandler(makeDb({
    queries, cardRow: { ...FIXTURE_CARD_ROW, card_id: '777', ct_id: '88' },
    askRows: [{ min_price_pkn: 11128, median_price_pkn: 999999,
      observed_day: new Date('2026-10-02T00:00:00Z'), refreshed_at: new Date('2026-10-02T02:27:50Z') }],
  }), async (params) => {
    historyCalls.push(params);
    return {
      cardtrader: cardtraderSource([
        { day: '2026-09-30', dump_day: '2026-09-29', lowest_ask_pkn: 13128, listing_count: 4,
          refreshed_at: '2026-09-30T15:57:44Z', seller_uid: 'PRIVATE' },
        { day: '2026-10-02', dump_day: '2026-10-01', lowest_ask_pkn: 11128, listing_count: 5,
          refreshed_at: '2026-10-02T02:27:50Z' },
      ]),
      tcgplayer: tcgplayerSource([{ category_id: 85, product_id: 719552, subtype: 'Holofoil',
        observed_on: '2026-09-30', market_price: 59.27, low_price: 56, mid_price: 60.89,
        high_price: 75, snapshot_timestamp: '2026-09-30T20:05:12Z', email: 'PRIVATE' }]),
    };
  });
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '777' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.card.blueprintId, 88);
  const quote = res.body.quotes[0];
  assert.equal(quote.askingPriceOnly, true);
  assert.equal(quote.estimate, null);
  assert.equal(quote.strategies, null);
  assert.equal(quote.currentAsk.min, 11128);
  assert.equal(quote.currentAsk.median, undefined);
  assert.equal(quote.currentAsk.observedDay, '2026-10-02');
  assert.equal(quote.currentAsk.sourceTimestamp, '2026-10-02T02:27:50.000Z');
  assert.equal(res.body.priceSources.cardtrader.currency, 'PKN');
  assert.equal(res.body.priceSources.tcgplayer.currency, 'USD');
  const tcg = res.body.priceSources.tcgplayer.series[0];
  assert.equal(tcg.subtype, 'Holofoil');
  assert.equal(tcg.days[0].marketPrice, 59.27);
  assert.equal(tcg.days[0].day, '2026-09-30');
  assert.equal(res.body.priceSources.tcgplayer.conditionSpecific, false);
  assert.equal(res.body.askHistory.trend, 'falling');
  assert.equal(res.body.askHistory.series[0].median, undefined);
  assert.equal(historyCalls[0].cardId, '777');
  assert.match(res.body.priceSources.citationUrl, /cardId=777/);
  assert.match(res.body.dataNote, /Zero sold comps does not mean no price analytics/);
  assert.ok(queries.filter(q => /cardtrader_sold_daily|cardtrader_market_listing_snapshots/.test(q.sql))
    .every(q => q.params[0] === '88'), 'all blueprint queries use catalog ct_id');
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));
});

test('optional history outage preserves current asks and reports source availability', async () => {
  const handler = loadHandler(makeDb({ queries: [], askRows: [{ min_price_pkn: 48 }] }),
    async () => { throw new Error('history unavailable'); });
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '246912' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quotes[0].currentAsk.min, 48);
  assert.equal(res.body.priceSources.cardtrader.status, 'unavailable');
  assert.equal(res.body.priceSources.tcgplayer.status, 'unavailable');
  assert.deepEqual(res.body.askHistory.series, []);
});

test('unmapped catalog cards never guess a blueprint from an even public ID', async () => {
  const queries = [];
  const handler = loadHandler(makeDb({ queries, cardRow: { ...FIXTURE_CARD_ROW, ct_id: null } }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '246912' } } }), res);
  assert.equal(res.body.status, 'unsupported');
  assert.ok(!queries.some(q => /cardtrader_/.test(q.sql)));
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
    ct_id: String(123456 + i),
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
  assert.equal(res.body.priceUnit, 'PKN');
  assert.equal(res.body.pknEurRate, 0.005);
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
    soldRows: [soldDay({ sold_qty: 28, median_pkn: 34, observed_day: '2026-09-25' })],
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

test('card_ocr returns leftover chrome text and refuses missing/junk inventively', async () => {
  const ocrRows = [{
    card_id: '246912',
    leftover_id: 123456,
    name: 'Raichu ex',
    set_name: 'EX Team Rocket Returns',
    card_number: '8/109',
    text: 'BASIC\nRaichu ex\nHP90\nThunderbolt\n40\nDiscard all Energy attached to Raichu ex.',
    junk: false,
    ok: true,
    engine: 'ppocrv5-onnx-rocm',
    crop: 'chrome',
    line_count: 8,
    updated_at: '2026-09-14T18:00:00.000Z',
    seller_uid: 'MUST_NOT_LEAK',
  }];
  let res = makeRes();
  await loadHandler(makeDb({ queries: [], ocrRows }))(
    makeReq({ body: { tool: 'card_ocr', params: { cardId: '246912' } } }), res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.match(res.body.ocr.text, /Thunderbolt/);
  assert.equal(res.body.ocr.confidence, 'medium');
  assert.equal(res.body.ocr.leftoverId, 123456);
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));

  res = makeRes();
  await loadHandler(makeDb({ queries: [], ocrRows: [] }))(
    makeReq({ body: { tool: 'card_ocr', params: { cardId: '246912' } } }), res,
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.status, 'not_found');
  assert.match(res.body.note, /do not invent/i);
});

test('top_movers ranks a subject by ask change and drops sub-floor noise', async () => {
  const stubs = {
    queries: [],
    moverRows: [
      { card_id: '1000', name: 'Raikou', set_name: 'Aquapolis', card_number: 'H21/H32', start_px: 5000, start_day: '2026-08-29', end_px: 6500, end_day: '2026-09-27', points: 20, seller_uid: 'X' },
      { card_id: '2000', name: 'Raikou V', set_name: 'Brilliant Stars', card_number: '172/172', start_px: 20000, start_day: '2026-08-29', end_px: 36000, end_day: '2026-09-27', points: 25 },
      { card_id: '3000', name: 'Raikou', set_name: 'Unleashed', card_number: '12/95', start_px: 900, start_day: '2026-08-29', end_px: 700, end_day: '2026-09-27', points: 8 },
      { card_id: '4000', name: 'Raikou', set_name: 'Bulk', card_number: '1/100', start_px: 20, start_day: '2026-08-29', end_px: 80, end_day: '2026-09-27', points: 9 },
    ],
  };
  const handler = loadHandler(makeDb(stubs));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'top_movers', params: { subject: 'Raikou', days: 30 } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.direction, 'up');
  assert.deepEqual(res.body.movers.map((m) => m.setName), ['Brilliant Stars', 'Aquapolis']);
  assert.equal(res.body.movers[0].changePct, 80);
  assert.equal(res.body.movers[0].fromAsk, 20000);
  assert.equal(res.body.movers[0].toAsk, 36000);
  assert.equal(res.body.movers[0].fromAskEur, 100);
  assert.equal(res.body.movers[0].toAskEur, 180);
  assert.equal(res.body.movers[0].cardNumber, '172/172');
  assert.equal(res.body.window.days, 30);
  assert.equal(res.body.priceUnit, 'PKN');
  assert.equal(res.body.pknEurRate, 0.005);
  assert.equal(res.body.minPricePkn, 400);
  assert.equal(res.body.minPriceEur, 2);
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));
  const sql = stubs.queries.find((q) => /with cands as/.test(q.sql));
  assert.deepEqual(sql.params, [30, 400, '%raikou%']);
  assert.ok(!sql.sql.includes('median_price_pkn'));
  assert.match(sql.sql, /refreshed_at at time zone 'utc'/);
  assert.match(sql.sql, /s.ct_id as blueprint_id/);
  assert.match(res.body.basis, /lowest listed ask/);
});

test('top_movers supports falling direction and answers empty windows with 200', async () => {
  const rows = [
    { card_id: '1000', name: 'Raikou', set_name: 'A', start_px: 5000, start_day: '2026-09-01', end_px: 6500, end_day: '2026-09-27', points: 5 },
    { card_id: '3000', name: 'Raikou', set_name: 'B', start_px: 900, start_day: '2026-09-01', end_px: 700, end_day: '2026-09-27', points: 5 },
  ];
  let res = makeRes();
  await loadHandler(makeDb({ queries: [], moverRows: rows }))(
    makeReq({ body: { tool: 'top_movers', params: { subject: 'raikou', direction: 'down' } } }), res,
  );
  assert.deepEqual(res.body.movers.map((m) => m.setName), ['B']);
  assert.equal(res.body.movers[0].changePct, -22.2);

  res = makeRes();
  await loadHandler(makeDb({ queries: [] }))(
    makeReq({ body: { tool: 'top_movers', params: { subject: 'raikou' } } }), res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.movers, []);
  assert.match(res.body.note, /raikou/i);
});

test('top_sellers ranks confirmed sales with language, rarity and price filters', async () => {
  const stubs = {
    queries: [],
    sellerRows: [
      { card_id: '1000', name: 'Mega Froslass ex', set_name: 'MEGA Dream ex', card_number: 'Special Illustration Rare | 233/193', sold_qty: 24, sale_days: 13, median_pkn: 3188, ask_pkn: 3174, last_sale_day: '2026-09-29', seller_uid: 'X' },
      { card_id: '2000', name: "Giovanni's Charisma", set_name: 'Pokémon Card 151', card_number: 'Special Illustration Rare | 207/165', sold_qty: 19, sale_days: 5, median_pkn: 5066, ask_pkn: 3654, last_sale_day: '2026-09-28' },
    ],
  };
  const res = makeRes();
  await loadHandler(makeDb(stubs))(makeReq({
    body: { tool: 'top_sellers', params: { language: 'giapponese', rarity: 'SIR', minPriceEur: 10, days: 30, limit: 10 } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.cards.map((c) => c.name), ['Mega Froslass ex', "Giovanni's Charisma"]);
  assert.equal(res.body.cards[0].soldQty, 24);
  assert.equal(res.body.cards[0].saleDays, 13);
  assert.equal(res.body.cards[0].medianSoldPkn, 3188);
  assert.equal(res.body.cards[0].medianSoldEur, 15.94);
  assert.equal(res.body.cards[0].currentAskPkn, 3174);
  assert.equal(res.body.filters.language, 'JP');
  assert.equal(res.body.filters.rarity, 'Special Illustration Rare');
  assert.equal(res.body.filters.minPricePkn, 2000);
  assert.equal(res.body.window.days, 30);
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));
  const sql = stubs.queries.find((q) => /with sold as/.test(q.sql));
  assert.deepEqual(sql.params, [30, 'JP', 2000, null, 10, 'Special Illustration Rare', 20]);
  assert.match(sql.sql, /not graded/);
  assert.match(sql.sql, /ask_pkn \* \$7/);
});

test('top_sellers defaults to all languages over 7 days and answers empty with 200', async () => {
  const stubs = { queries: [] };
  const res = makeRes();
  await loadHandler(makeDb(stubs))(makeReq({ body: { tool: 'top_sellers', params: { subject: 'Charizard' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.cards, []);
  assert.match(res.body.note, /7 days/);
  assert.equal(res.body.filters.language, 'all');
  const sql = stubs.queries.find((q) => /with sold as/.test(q.sql));
  assert.deepEqual(sql.params, [7, null, 0, null, 10, null, 20, '%charizard%']);
  assert.match(sql.sql, /s\.search_text ilike \$8/);
});

test('normalizeRarity maps SIR / SAR / AR shorthands to catalog labels', () => {
  const { normalizeRarity } = require('./poko-market')._test;
  assert.equal(normalizeRarity('SIR'), 'Special Illustration Rare');
  assert.equal(normalizeRarity('special art rare'), 'Special Illustration Rare');
  assert.equal(normalizeRarity('AR'), 'Illustration Rare');
  assert.equal(normalizeRarity(''), '');
});

test('artist_cards resolves the artist from the desk cardId and ranks by price', async () => {
  const stubs = {
    queries: [],
    artistRows: [{ artist: 'Ken Sugimori', cards: 521 }],
    artistCardRows: [
      { card_id: '10', name: "Koga's Ninja Trick", set_name: 'Gym Booster 2', median_pkn: 70128, sold_qty: 2, current_ask_pkn: 80126, sold_ok: true },
      { card_id: '20', name: 'Minun', set_name: 'PLAY Promos', median_pkn: null, current_ask_pkn: 70126, sold_ok: false },
      { card_id: '30', name: 'Drowzee', set_name: 'Rising Fist', median_pkn: null, current_ask_pkn: 1402700, sold_ok: false },
      { card_id: '40', name: 'Magikarp', set_name: 'Expansion Pack', median_pkn: 2000328, sold_qty: 2, current_ask_pkn: 822, sold_ok: false, seller_uid: 'X' },
    ],
  };
  const res = makeRes();
  await loadHandler(makeDb(stubs))(makeReq({ body: { tool: 'artist_cards', params: { cardId: '246912' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.artist, 'Ken Sugimori');
  assert.deepEqual(res.body.fromCard, {
    cardId: '246912',
    name: 'Raichu ex',
    setName: 'EX Team Rocket Returns',
    illustrator: 'Ken Sugimori',
    note: 'Raichu ex (EX Team Rocket Returns) is illustrated by Ken Sugimori (Pokoin catalog).',
  });
  assert.equal(res.body.artistCardCount, 521);
  assert.equal(res.body.sort, 'expensive');
  assert.deepEqual(res.body.cards.map((c) => [c.name, c.priceBasis]), [
    ["Koga's Ninja Trick", 'sold_median_90d'],
    ['Minun', 'lowest_ask'],
    ['Magikarp', 'lowest_ask'],
  ]);
  assert.equal(res.body.cards[2].pricePkn, 822);
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));
  const lookup = stubs.queries.find((q) => /select artist, name, set_name from marketplace_search_candidates/.test(q.sql));
  assert.deepEqual(lookup.params, ['246912']);
  const sql = stubs.queries.find((q) => /with art as/.test(q.sql));
  assert.deepEqual(sql.params, ['Ken Sugimori', null, 20]);
  assert.match(sql.sql, /asks\.ask_pkn \* 3/);
});

test('artist_cards asks for clarification when several artists fit', async () => {
  const stubs = { queries: [], artistRows: [{ artist: 'Ken Sugimori', cards: 500 }, { artist: 'Kent Kanda', cards: 10 }] };
  const res = makeRes();
  await loadHandler(makeDb(stubs))(makeReq({ body: { tool: 'artist_cards', params: { artist: 'ken' } } }), res);
  assert.equal(res.body.status, 'ambiguous');
  assert.equal(res.body.artists.length, 2);
});

test('set_info returns era, nationality, release languages and localized names', async () => {
  const stubs = {
    queries: [],
    expansionRows: [
      { name: 'Mysterious Treasures', official_id: 'dp2', official_name: 'Mysterious Treasures', nationality: 'western', kind: 'official', listed: true, catalog_card_count: 124, release_languages: ['DE', 'EN', 'IT'], localized_names: { it: 'Tesori Misteriosi' } },
      { name: 'MEGA Dream ex', official_id: 'M2a', official_name: 'MEGAドリームex', nationality: 'japanese', kind: 'official', listed: true, catalog_card_count: 250, release_languages: ['JP'], localized_names: {} },
    ],
  };
  const res = makeRes();
  await loadHandler(makeDb(stubs))(makeReq({ body: { tool: 'set_info', params: { setName: 'Tesori Misteriosi' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sets.map((set) => [set.name, set.era, set.nationality]), [
    ['Mysterious Treasures', 'Diamond & Pearl', 'western'],
    ['MEGA Dream ex', 'Mega Evolution', 'japanese'],
  ]);
  assert.deepEqual(res.body.sets[0].releaseLanguages, ['DE', 'EN', 'IT']);
  assert.equal(res.body.sets[0].localizedNames.it, 'Tesori Misteriosi');
  const sql = stubs.queries.find((q) => /pokoin_pokemon_expansions/.test(q.sql));
  assert.deepEqual(sql.params, [null, 'Tesori Misteriosi', '%Tesori Misteriosi%']);

  const jp = makeRes();
  await loadHandler(makeDb(stubs))(makeReq({ body: { tool: 'set_info', params: { language: 'JP', era: 'mega' } } }), jp);
  assert.deepEqual(jp.body.sets.map((set) => set.name), ['MEGA Dream ex']);
  assert.equal(stubs.queries.at(-1).params[0], 'japanese');

  const bad = makeRes();
  await loadHandler(makeDb({ queries: [] }))(makeReq({ body: { tool: 'set_info', params: {} } }), bad);
  assert.equal(bad.statusCode, 400);
});

test('eraForCode maps western, Japanese and Chinese series codes', () => {
  const { eraForCode } = require('./poko-market')._test;
  assert.equal(eraForCode('neo2'), 'Wizards of the Coast');
  assert.equal(eraForCode('SV8a'), 'Scarlet & Violet');
  assert.equal(eraForCode('CSV4C'), 'Scarlet & Violet');
  assert.equal(eraForCode('swsh9tg'), 'Sword & Shield');
  assert.equal(eraForCode('tk-xy-latia'), 'XY');
  assert.equal(eraForCode('m6'), 'Mega Evolution');
  assert.equal(eraForCode(''), null);
});

test('dedupeArtworkVersions keeps one printing per CLIP version key', () => {
  const { dedupeArtworkVersions, candidateFromRow } = require('./poko-market')._test;
  const rows = [
    { card_id: '245802', name: "Mom's Kindness", set_name: 'Majestic Dawn', version: 'v245802' },
    { card_id: '624102', name: "Mom's Kindness", set_name: 'Arceus LV.X Deck', version: 'v245802' },
    { card_id: '999001', name: "Mom's Kindness", set_name: 'Alt Art Set', version: 'v999001' },
  ];
  const kept = dedupeArtworkVersions(rows);
  assert.equal(kept.length, 2);
  assert.equal(String(kept[0].card_id), '245802');
  assert.equal(String(kept[1].card_id), '999001');
  const cand = candidateFromRow(rows[0]);
  assert.equal(cand.path, '/marketplace/en/cards/245802');
  assert.equal(cand.version, 'v245802');
});

// Neo Discovery Caterpie, 2026-09-30: 1st Edition NM sold at 668 and 2404
// while Unlimited NM sold at 216–644. The old quote blended them into 643.
const CATERPIE_SOLD = [
  soldDay({ observed_day: '2026-09-27', sold_qty: 1, median_pkn: 216 }),
  soldDay({ observed_day: '2026-09-22', sold_qty: 4, median_pkn: 320 }),
  soldDay({ observed_day: '2026-09-23', sold_qty: 1, median_pkn: 644 }),
  soldDay({ observed_day: '2026-09-27', sold_qty: 1, median_pkn: 668, first_edition: true }),
  soldDay({ observed_day: '2026-09-22', sold_qty: 1, median_pkn: 2404, first_edition: true }),
  soldDay({ observed_day: '2026-09-29', condition: 'SP', language: 'IT', sold_qty: 2, median_pkn: 68 }),
  soldDay({ observed_day: '2026-09-20', sold_qty: 1, median_pkn: 9000, graded: true }),
];

test('card_quote never mixes 1st Edition, reverse or graded sales into the standard price', async () => {
  const handler = loadHandler(makeDb({ queries: [], soldRows: CATERPIE_SOLD }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '247128', condition: 'NM', language: 'EN' } } }), res);
  assert.equal(res.statusCode, 200);
  const est = res.body.quotes[0].estimate;
  assert.equal(est.sampleSize, 6);
  assert.equal(est.median, 320, 'unit-weighted: four 320 sales outweigh one 216 and one 644');
  assert.ok(est.high < 668, 'no 1st Edition or graded price leaks into the standard slice');
  assert.equal(res.body.filters.variant, 'Standard (unlimited, non-reverse, ungraded)');
  const variants = res.body.variantsSold.map((v) => v.variant);
  assert.ok(variants.includes('1st Edition'));
  assert.ok(variants.includes('Graded'));

  const res1st = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '247128', firstEdition: '1st edition' } } }), res1st);
  assert.equal(res1st.body.filters.variant, '1st Edition');
  assert.equal(res1st.body.quotes[0].estimate.sampleSize, 2);
  assert.equal(res1st.body.quotes[0].estimate.low, 668);
});

test('card_quote without condition/language quotes every copy instead of hiding non-NM/EN sales', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: [
      soldDay({ condition: 'SP', language: 'EN', sold_qty: 1, median_pkn: 30128 }),
      soldDay({ condition: 'SP', language: 'IT', sold_qty: 1, median_pkn: 36148, observed_day: '2026-09-22' }),
    ],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '259710' } } }), res);
  const quote = res.body.quotes[0];
  assert.equal(res.body.filters.condition, 'all');
  assert.equal(res.body.filters.language, 'all');
  assert.equal(quote.estimate.sampleSize, 2);
  assert.equal(quote.askingPriceOnly, false);
  assert.equal(quote.askVsSold, null, 'no cheapest-ask verdict across mixed conditions');

  const resNm = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '259710', condition: 'NM', language: 'EN' } } }), resNm);
  assert.equal(resNm.body.quotes[0].estimate.sampleSize, 2);
  assert.match(resNm.body.quotes[0].estimateFallback, /No NM EN sale/);
});

test('card_quote snaps to the most-sold variant when a printing never sold a standard copy', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: [soldDay({ reverse: true, sold_qty: 3, median_pkn: 80 })],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '247128' } } }), res);
  assert.equal(res.body.filters.variant, 'Reverse Holo');
  assert.match(res.body.variantNote, /most-sold variant/);
  assert.equal(res.body.quotes[0].estimate.median, 80);
});

test('card_quote compares live asks from the same slice only', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: CATERPIE_SOLD,
    liveRows: [
      { condition: 'NM', language: 'EN', reverse: false, first_edition: false, listings: 14, copies: 20, min_eur: 1.6, median_eur: 1.8 },
      { condition: 'NM', language: 'EN', reverse: false, first_edition: true, listings: 1, copies: 1, min_eur: 10.22, median_eur: 10.22 },
      { condition: 'Poor', language: 'IT', reverse: false, first_edition: false, listings: 16, copies: 16, min_eur: 0.11, median_eur: 0.2 },
    ],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_quote', params: { cardId: '247128', condition: 'NM', language: 'EN' } } }), res);
  const quote = res.body.quotes[0];
  assert.equal(quote.currentAsk.min, 320);
  assert.equal(quote.currentAsk.listings, 14);
  assert.equal(quote.askVsSold.verdict, 'in_line_with_sales');
});

test('card_sales lists dated slices and 7/30/90-day totals for the standard variant', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: [
      soldDay({ observed_day: today, sold_qty: 2, median_pkn: 300 }),
      soldDay({ observed_day: today, sold_qty: 1, median_pkn: 900, first_edition: true }),
    ],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'card_sales', params: { cardId: '247128', days: 7 } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totals.last7d.units, 2);
  assert.equal(res.body.lastSale.medianPkn, 300);
  assert.equal(res.body.sales.length, 1);
  assert.equal(res.body.otherVariants[0].variant, '1st Edition');
  assert.ok(!FORBIDDEN.test(JSON.stringify(res.body)));
});

test('deal_check compares each live slice with its own sold comps and cautions on outliers', async () => {
  const handler = loadHandler(makeDb({
    queries: [],
    soldRows: [
      soldDay({ sold_qty: 4, median_pkn: 320 }),
      soldDay({ condition: 'MP', sold_qty: 3, median_pkn: 400 }),
    ],
    liveRows: [
      { condition: 'NM', language: 'EN', reverse: false, first_edition: false, listings: 5, copies: 5, min_eur: 1.5, median_eur: 2 },
      { condition: 'MP', language: 'EN', reverse: false, first_edition: false, listings: 9, copies: 9, min_eur: 0.24, median_eur: 0.5 },
      { condition: 'Poor', language: 'IT', reverse: false, first_edition: false, listings: 2, copies: 2, min_eur: 0.11, median_eur: 0.11 },
    ],
  }));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'deal_check', params: { cardId: '247128' } } }), res);
  assert.equal(res.statusCode, 200);
  const byCond = Object.fromEntries(res.body.offers.map((o) => [`${o.condition}/${o.language}`, o]));
  assert.equal(byCond['NM/EN'].verdict, 'in_line_with_sales');
  assert.equal(byCond['MP/EN'].verdict, 'far_below_sold_median');
  assert.match(byCond['MP/EN'].caution, /delisted/);
  assert.equal(byCond['Poor/IT'].verdict, 'no_same_slice_sales');
  assert.equal(res.body.offers[0].condition, 'Poor', 'offers sorted cheapest first');
  assert.equal(res.body.bestValue.condition, 'NM', 'suspicious far-below slices never headline');
});

test('set_sales totals an expansion and ranks by units and by price', async () => {
  const stubs = {
    queries: [],
    setRows: [
      { card_id: 247154, name: 'Tyrogue', set_name: 'Neo Discovery', item_kind: 'single', card_number: '66/75', sold_qty: 89, value_pkn: 37166, median_pkn: 218, last_sale_day: '2026-09-27' },
      { card_id: 247048, name: 'Umbreon', set_name: 'Neo Discovery', item_kind: 'single', card_number: '13/75', sold_qty: 4, value_pkn: 80000, median_pkn: 20000, last_sale_day: '2026-09-26' },
    ],
  };
  const handler = loadHandler(makeDb(stubs));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'set_sales', params: { setName: 'Neo Discovery set', days: 30 } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totals.unitsSold, 93);
  assert.equal(res.body.topByUnits[0].name, 'Tyrogue');
  assert.equal(res.body.topByValue[0].name, 'Umbreon');
  const sql = stubs.queries.find((q) => /with cards as/.test(q.sql));
  assert.deepEqual(sql.params, [30, null, 20, '%neo%', '%discovery%']);

  const bad = makeRes();
  await handler(makeReq({ body: { tool: 'set_sales', params: {} } }), bad);
  assert.equal(bad.statusCode, 400);
});

test('recent_sales sorts by price or date and flags sales far above the typical ask', async () => {
  const stubs = {
    queries: [],
    recentRows: [
      { card_id: 469492, name: 'Umbreon VMAX', set_name: 'Eevee Heroes', item_kind: 'single', card_number: '095/069', observed_day: '2026-09-27', condition: 'NM', language: 'JP', reverse: false, first_edition: false, graded: false, sold_qty: 1, median_pkn: 1000128, ask_pkn: 240118 },
      { card_id: 713886, name: 'Mega Charizard X ex', set_name: 'MEP Black Star Promos', item_kind: 'single', card_number: 'MEP 023', observed_day: '2026-09-29', condition: 'NM', language: 'EN', reverse: false, first_edition: false, graded: false, sold_qty: 1, median_pkn: 7742, ask_pkn: 7000 },
    ],
  };
  const handler = loadHandler(makeDb(stubs));
  const res = makeRes();
  await handler(makeReq({ body: { tool: 'recent_sales', params: { language: 'japanese', minPriceEur: 10, days: 7 } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sales[0].unverified, true);
  assert.equal(res.body.sales[1].unverified, undefined);
  const sql = stubs.queries.find((q) => /with recent as/.test(q.sql));
  assert.deepEqual(sql.params.slice(0, 4), [7, 'JP', false, 2000]);
  assert.match(sql.sql, /order by recent\.median_pkn desc/);

  await handler(makeReq({ body: { tool: 'recent_sales', params: { sort: 'recent', subject: 'Charizard' } } }), makeRes());
  const sql2 = stubs.queries.filter((q) => /with recent as/.test(q.sql))[1];
  assert.match(sql2.sql, /order by recent\.observed_day desc/);
  assert.match(sql2.sql, /s\.search_text ilike \$7/);
});

test('soldFlag reads casual variant words and leaves unknown text unset', () => {
  assert.equal(T.soldFlag('1st edition'), true);
  assert.equal(T.soldFlag('prima edizione'), true);
  assert.equal(T.soldFlag('unlimited'), false);
  assert.equal(T.soldFlag('banana'), null);
  assert.deepEqual(T.soldFacetFromParams({}), { reverse: false, firstEdition: false, graded: false, explicit: false });
});
