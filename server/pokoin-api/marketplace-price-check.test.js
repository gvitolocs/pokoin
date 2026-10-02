import assert from 'node:assert/strict';
import test from 'node:test';
import { parseItems, pickMatchedCt, readPrices } from './marketplace-price-check.js';

test('price check parses cardId[:COND:LANG] items with a cap', () => {
  const items = parseItems('633380:NM:IT, 713648 , bad:, x:SP');
  assert.deepEqual(items, [
    { cardId: '633380', condition: 'NM', language: 'IT' },
    { cardId: '713648', condition: '', language: '' },
  ]);
  const many = parseItems(Array.from({ length: 150 }, (_, i) => `${i + 1}`).join(','));
  assert.equal(many.length, 100);
  assert.deepEqual(parseItems(''), []);
});

test('price check picks the matched CardTrader group, else the overall low', () => {
  const groups = [
    { condition: 'NM', language: 'EN', minPkn: 210 },
    { condition: 'NM', language: 'IT', minPkn: 180 },
    { condition: 'SP', language: 'EN', minPkn: 150 },
    { condition: 'MP', language: 'DE', minPkn: 90 },
  ];
  const { ctCheapestPkn, ctMatchedPkn } = pickMatchedCt(groups, 'NM', 'IT');
  assert.equal(ctCheapestPkn, 90);
  assert.equal(ctMatchedPkn, 180);
  // A condition with no CT rows falls back to the overall cheapest.
  const only = pickMatchedCt([{ condition: 'Poor', language: 'FR', minPkn: 40 }], 'NM', 'IT');
  assert.deepEqual(only, { ctCheapestPkn: 40, ctMatchedPkn: null });
  assert.deepEqual(pickMatchedCt([], 'NM', 'IT'), { ctCheapestPkn: null, ctMatchedPkn: null });
});


test('price-check input preserves full numeric identities and rejects partially numeric text', () => {
  assert.deepEqual(parseItems('900719925474099301:NM:JP,0042,42bad,42;drop,0'), [
    { cardId: '900719925474099301', condition: 'NM', language: 'JP' },
    { cardId: '42', condition: '', language: '' },
  ]);
});

function pricingQuery(mappings, seen = []) {
  return async (sql, values) => {
    seen.push({ sql, values });
    if (sql.includes('marketplace_search_candidates')) return { rows: mappings };
    if (sql.includes('marketplace_user_listings')) return { rows: [{ card_id: '777', min_pkn: '900' }] };
    if (sql.includes('cardtrader_market_listing_snapshots')) return { rows: [
      { ct_id: '88', condition_key: 'NM', language_key: 'JP', min_pkn: '1200' },
      { ct_id: '99', condition_key: 'NM', language_key: 'EN', min_pkn: '2400' },
      // A public-number collision should never become the requested card's CT quote.
      { ct_id: '777', condition_key: 'NM', language_key: 'EN', min_pkn: '1' },
    ] };
    if (sql.includes('cardtrader_blueprint_daily_analytics')) return { rows: [
      { blueprint_id: '88', day: '2026-10-02', dump_day: '2026-10-01', lowest_ask_pkn: '1200',
        listing_count: 2, listed_quantity: 3, seller_count: 2, refreshed_at: '2026-10-02T02:00:00Z' },
    ] };
    if (sql.includes('cardtrader_sold_daily')) return { rows: [
      { blueprint_id: '88', sold_median_pkn: '1300' },
      { blueprint_id: '99', sold_median_pkn: '2500' },
      { blueprint_id: '777', sold_median_pkn: '2' },
    ] };
    throw new Error('Unexpected price-check query');
  };
}
const noTcg = async () => ({ status: 'empty', prices: {} });

test('nonarithmetic public IDs resolve candidate mapping for both asks and sold medians', async () => {
  const seen = [];
  const result = await readPrices(parseItems('777:NM:JP,888:NM:EN'), { excludeSellerUid: 'own-seller' }, {
    marketplaceQuery: pricingQuery([{ card_id: '777', ct_id: '88' }, { card_id: '888', ct_id: '99' }], seen),
    currentGame: () => 'pokemon', readTcgplayerPrices: noTcg,
  });
  assert.equal(result['777'].ctCheapestPkn, 1200); assert.equal(result['777'].ctMatchedPkn, 1200);
  assert.equal(result['777'].soldMedianPkn, 1300); assert.equal(result['777'].pokoinCheapestPkn, 900);
  assert.equal(result['888'].ctCheapestPkn, 2400); assert.equal(result['888'].soldMedianPkn, 2500);
  const nativeQuery = seen.find((q) => q.sql.includes('marketplace_user_listings'));
  assert.deepEqual(nativeQuery.values, [['777','888'], 'own-seller']);
  assert.match(nativeQuery.sql, /card_id = any\(\$1::text\[\]\)/);
  for (const table of ['cardtrader_market_listing_snapshots', 'cardtrader_sold_daily']) {
    assert.deepEqual(seen.find((q) => q.sql.includes(table)).values, [['88','99']]);
  }
});

test('public/blueprint ID collision and unmapped IDs never fall back to raw or divided identity', async () => {
  const seen = [];
  const result = await readPrices(parseItems('777,176,999'), {}, {
    marketplaceQuery: pricingQuery([{ card_id: '777', ct_id: '88' }, { card_id: '176', ct_id: '99' }], seen),
    currentGame: () => 'pokemon', readTcgplayerPrices: noTcg,
  });
  assert.equal(result['777'].soldMedianPkn, 1300);
  // 176 / 2 would have incorrectly selected blueprint 88 instead of the authoritative 99.
  assert.equal(result['176'].ctCheapestPkn, 2400); assert.equal(result['176'].soldMedianPkn, 2500);
  assert.equal(result['999'].ctCheapestPkn, null); assert.equal(result['999'].soldMedianPkn, null);
  assert.deepEqual(seen[0].values, [['777','176','999']]);
});

test('different public IDs explicitly linked to one blueprint retain separate native and CT outputs', async () => {
  const result = await readPrices(parseItems('777,888'), {}, {
    marketplaceQuery: pricingQuery([{ card_id: '777', ct_id: '88' }, { card_id: '888', ct_id: '88' }]),
    currentGame: () => 'magic', readTcgplayerPrices: async (game, ids) => {
      assert.equal(game, 'magic'); assert.deepEqual(ids, ['777','888']); return { status: 'available', prices: {} };
    },
  });
  assert.equal(result['777'].soldMedianPkn, 1300); assert.equal(result['888'].soldMedianPkn, 1300);
  assert.equal(result['777'].pokoinCheapestPkn, 900); assert.equal(result['888'].pokoinCheapestPkn, null);
});


test('pricer receives bounded daily dump asks in one bulk query with distinct source semantics', async () => {
  const seen = [];
  const result = await readPrices(parseItems('777:SP:IT,888:NM:EN'), {}, {
    marketplaceQuery: pricingQuery([{ card_id: '777', ct_id: '88' }, { card_id: '888', ct_id: '99' }], seen),
    currentGame: () => 'pokemon', readTcgplayerPrices: noTcg,
  });
  const queries = seen.filter((q) => q.sql.includes('cardtrader_blueprint_daily_analytics'));
  assert.equal(queries.length, 1); assert.deepEqual(queries[0].values[0], ['88', '99']);
  assert.equal((Date.parse(queries[0].values[2])-Date.parse(queries[0].values[1]))/86400000, 29);
  assert.doesNotMatch(queries[0].sql, /median_price_pkn|sold_quantity|sold_count/);
  const listed = result['777'].cardtraderListed;
  assert.equal(listed.source, 'cardtrader_listed'); assert.equal(listed.currency, 'PKN');
  assert.equal(listed.conditionSpecific, false); assert.equal(listed.languageSpecific, false);
  assert.equal(listed.days[0].lowestAskPkn, 1200); assert.equal(listed.days[0].day, '2026-10-02');
  assert.equal(listed.days[0].dumpDay, '2026-10-01'); assert.equal(listed.days[0].sourceTimestamp, '2026-10-02T02:00:00Z');
  assert.equal(result['888'].cardtraderListed.status, 'empty');
});

test('daily analytics outage leaves live CardTrader asks and sold comp fields unchanged', async () => {
  const base = pricingQuery([{ card_id: '777', ct_id: '88' }]);
  const result = await readPrices(parseItems('777:NM:JP'), {}, {
    marketplaceQuery: (sql, values) => {
      if (sql.includes('cardtrader_blueprint_daily_analytics')) return Promise.reject(new Error('feed offline'));
      return base(sql, values);
    }, currentGame: () => 'pokemon', readTcgplayerPrices: noTcg,
  });
  assert.equal(result['777'].ctCheapestPkn, 1200); assert.equal(result['777'].ctMatchedPkn, 1200);
  assert.equal(result['777'].soldMedianPkn, 1300); assert.equal(result['777'].cardtraderListed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /feed offline/);
});
