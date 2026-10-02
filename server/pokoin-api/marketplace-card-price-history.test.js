'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCardPriceHistory, cardtraderSource, tcgplayerSource, CARD_SQL, LISTED_SQL } = require('./_card_price_history');
const { createHandler } = require('./marketplace-card-price-history');

const request = { game: 'pokemon', cardId: '824942', from: '2026-09-29', to: '2026-10-02' };
const card = { card_id: '824942', ct_id: '412471', name: 'Mewtwo ex', expansion_name: '30th celebration jp', card_number: '128' };
function queryWith(rows, seen = []) {
  return async (sql, values) => {
    seen.push({ sql, values });
    return { rows: sql === CARD_SQL ? [card] : rows };
  };
}
const ask = {
  day: new Date('2026-10-02T00:00:00Z'), dump_day: '2026-10-01', lowest_ask_pkn: '11128.000000',
  listing_count: 5, listed_quantity: 6, seller_count: 5, refreshed_at: new Date('2026-10-02T02:27:50.927Z'),
};
const quote = {
  observed_on: '2026-09-30', product_id: '719552', category_id: 85, group_id: 24721, subtype: 'Holofoil',
  market_price: '59.27', low_price: '56.00', mid_price: '60.89', high_price: '75.00',
  direct_low_price: null, snapshot_timestamp: '2026-09-30T20:05:12+00:00',
};

test('public identity resolves the exact candidate CT blueprint, never arithmetic or leftover fallback', async () => {
  const seen = [];
  const result = await readCardPriceHistory(request, { marketplaceQuery: queryWith([ask], seen),
    readTcgplayerHistory: async (game, id) => {
      assert.equal(game, 'pokemon'); assert.equal(id, '824942'); return { observations: [quote] };
    } });
  assert.deepEqual(seen.map((row) => row.values), [['824942'], ['412471', request.from, request.to]]);
  assert.doesNotMatch(CARD_SQL, /or ct_id|\/\s*2/i);
  assert.deepEqual(result.printing, { name: 'Mewtwo ex', setName: '30th celebration jp', number: '128' });
  assert.equal(result.cardtrader.days[0].lowestAskPkn, 11128);
  assert.equal(result.tcgplayer.series[0].days[0].marketPrice, '59.27');
});

test('CardTrader uses actual observation date, preserves assigned dump day and never labels cheapest a median or sale', () => {
  const result = cardtraderSource([ask]);
  assert.equal(result.source, 'cardtrader_listed'); assert.equal(result.currency, 'PKN');
  assert.equal(result.days[0].day, '2026-10-02'); assert.equal(result.days[0].dumpDay, '2026-10-01');
  assert.equal(result.days[0].sourceTimestamp, '2026-10-02T02:27:50.927Z');
  assert.deepEqual([result.days[0].listingCount, result.days[0].listedQuantity, result.days[0].sellerCount], [5, 6, 5]);
  assert.equal(result.conditionSpecific, false); assert.equal(result.languageSpecific, false);
  assert.doesNotMatch(JSON.stringify(result), /median|soldQty|sales/);
  assert.doesNotMatch(LISTED_SQL, /median_price_pkn|sold_quantity|insert|update|delete/i);
  assert.match(LISTED_SQL, /refreshed_at at time zone 'utc'/);
});

test('TCGplayer keeps distinct printing subtypes/products and exact decimal, null and zero quotes', () => {
  const result = tcgplayerSource([quote, { ...quote, subtype: 'Normal', market_price: '0.00' },
    { ...quote, product_id: '123', market_price: null }]);
  assert.equal(result.series.length, 3);
  assert.equal(result.series[1].days[0].marketPrice, '0.00');
  assert.equal(result.series[2].days[0].marketPrice, null);
  assert.equal(result.series[0].categoryId, 85); assert.equal(result.currency, 'USD');
  assert.equal(result.languageSpecific, false); assert.equal(result.conditionSpecific, false);
});

test('missing dates remain missing and a single quote never becomes a synthetic curve', () => {
  const result = tcgplayerSource([quote, { ...quote, observed_on: '2026-10-02' }]);
  assert.deepEqual(result.series[0].days.map((row) => row.day), ['2026-09-30', '2026-10-02']);
  assert.equal(tcgplayerSource([quote]).series[0].days.length, 1);
});

test('optional TCGplayer outage leaves CardTrader analytics available without exposing DB errors', async () => {
  const result = await readCardPriceHistory(request, { marketplaceQuery: queryWith([ask]),
    readTcgplayerHistory: async () => { throw new Error('sensitive DB connection'); } });
  assert.equal(result.cardtrader.status, 'available'); assert.equal(result.tcgplayer.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test('missing CardTrader analytics table does not hide imported TCGplayer observations', async () => {
  const result = await readCardPriceHistory(request, {
    marketplaceQuery: async (sql) => { if (sql === CARD_SQL) return { rows: [card] }; throw { code: '42P01' }; },
    readTcgplayerHistory: async () => ({ observations: [quote] }),
  });
  assert.equal(result.cardtrader.status, 'unavailable'); assert.equal(result.tcgplayer.status, 'available');
});

test('known card without observations returns two empty sources', async () => {
  const result = await readCardPriceHistory(request, { marketplaceQuery: queryWith([]),
    readTcgplayerHistory: async () => ({ observations: [] }) });
  assert.equal(result.cardtrader.status, 'empty'); assert.equal(result.tcgplayer.status, 'empty');
});

test('unknown public printing stops before external history access', async () => {
  let called = false;
  await assert.rejects(readCardPriceHistory(request, { marketplaceQuery: async () => ({ rows: [] }),
    readTcgplayerHistory: async () => { called = true; } }), { statusCode: 404 });
  assert.equal(called, false);
});

function response() {
  return { statusCode: null, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() {} };
}
function handlerWith(read = async (value) => value) {
  return createHandler({ currentGame: () => 'pokemon', readCardPriceHistory: read });
}
test('public bounded GET needs no bearer and has public caching and CORS', async () => {
  const res = response();
  await handlerWith()({ method: 'GET', url: '/api/marketplace-card-price-history?cardId=824942&from=2026-09-29&to=2026-10-02', headers: {} }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, request);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Cache-Control'], /^public/);
});
test('invalid date/ID or excessive range is rejected before any database work', async () => {
  for (const query of ['cardId=42&from=2024-02-30', 'cardId=42%3Bdrop+table',
    'cardId=42&from=2024-01-01&to=2040-01-01', 'cardId=42&from=2026-10-02&to=2024-01-01']) {
    const res = response();
    await handlerWith(async () => { throw new Error('must not query'); })({ method: 'GET', url: `/?${query}`, headers: {} }, res);
    assert.equal(res.statusCode, 400);
  }
});
test('OPTIONS is public and POST is disallowed', async () => {
  const options = response(); const post = response();
  await handlerWith()({ method: 'OPTIONS' }, options); await handlerWith()({ method: 'POST' }, post);
  assert.equal(options.statusCode, 204); assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET, OPTIONS');
});
test('unclassified DB failures return safe generic response', async () => {
  const res = response();
  await handlerWith(async () => { throw new Error('postgres://secret'); })({ method: 'GET', url: '/?cardId=42', headers: {} }, res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'Card price history unavailable.');
});


test('healthy partial response is not cached when either source is unavailable or unconfigured', async () => {
  for (const source of ['cardtrader', 'tcgplayer']) {
    for (const status of ['unavailable', 'unconfigured']) {
      const res = response();
      await handlerWith(async () => ({ cardtrader: { status: 'available', days: [ask] },
        tcgplayer: { status: 'available', series: [quote] }, [source]: { status } }))({
        method: 'GET', url: '/?cardId=824942', headers: {},
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.body[source].status, status);
    }
  }
});

test('healthy available and empty feeds retain public cache headers', async () => {
  const res = response();
  await handlerWith(async () => ({ cardtrader: { status: 'available', days: [ask] },
    tcgplayer: { status: 'empty', series: [] } }))({ method: 'GET', url: '/?cardId=824942', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Cache-Control'], /^public/);
});
