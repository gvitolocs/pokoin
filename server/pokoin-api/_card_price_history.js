'use strict';

const { readTcgplayerHistory } = require('./_tcgcsv_prices');
const { parseRange } = require('./marketplace-tcgplayer-history');
const marketplaceQuery = (...args) => require('./_marketplace_db').marketplaceQuery(...args);

// Exact public identity only: a public id can collide with another CT blueprint.
const CARD_SQL = `select card_id, ct_id, name, expansion_name, card_number
  from public.marketplace_search_candidates where card_id=$1::bigint limit 1`;
const LISTED_SQL = `select observed_day as dump_day,
    (refreshed_at at time zone 'utc')::date as day,
    min_price_pkn as lowest_ask_pkn, listing_count, listed_quantity, seller_count, refreshed_at
  from public.cardtrader_blueprint_daily_analytics
  where blueprint_id=$1::bigint
    and observed_day between $2::date - 1 and $3::date
    and (refreshed_at at time zone 'utc')::date between $2::date and $3::date
    and min_price_pkn > 0 and listing_count > 0
  order by refreshed_at, observed_day`;

function day(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}
function iso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}
function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}
function cardtraderSource(rows = [], status) {
  return {
    source: 'cardtrader_listed', currency: 'PKN', metric: 'lowestAsk',
    status: status || (rows.length ? 'available' : 'empty'),
    conditionSpecific: false, languageSpecific: false,
    days: rows.map((row) => ({
      day: day(row.day), dumpDay: day(row.dump_day),
      lowestAskPkn: Number(row.lowest_ask_pkn),
      listingCount: count(row.listing_count), listedQuantity: count(row.listed_quantity),
      sellerCount: count(row.seller_count), sourceTimestamp: iso(row.refreshed_at),
    })),
  };
}
function tcgplayerSource(rows = [], status) {
  const byProduct = new Map();
  for (const row of rows) {
    const key = `${row.category_id}:${row.product_id}:${row.subtype}`;
    if (!byProduct.has(key)) byProduct.set(key, {
      productId: String(row.product_id), categoryId: row.category_id,
      groupId: row.group_id, subtype: row.subtype, days: [],
    });
    byProduct.get(key).days.push({
      day: day(row.observed_on), marketPrice: row.market_price,
      lowPrice: row.low_price, midPrice: row.mid_price, highPrice: row.high_price,
      directLowPrice: row.direct_low_price, sourceTimestamp: iso(row.snapshot_timestamp),
    });
  }
  return {
    source: 'tcgcsv/tcgplayer', currency: 'USD', metric: 'marketPrice',
    status: status || (rows.length ? 'available' : 'empty'),
    conditionSpecific: false, languageSpecific: false, series: [...byProduct.values()],
  };
}

async function readCardPriceHistory({ game, cardId, from, to }, dependencies = {}) {
  const query = dependencies.marketplaceQuery || marketplaceQuery;
  const readTcg = dependencies.readTcgplayerHistory || readTcgplayerHistory;
  const card = (await query(CARD_SQL, [cardId])).rows[0];
  if (!card) { const error = new Error('Card not found.'); error.statusCode = 404; throw error; }
  const [listed, tcg] = await Promise.allSettled([
    card.ct_id ? query(LISTED_SQL, [String(card.ct_id), from, to]) : Promise.resolve({ rows: [] }),
    readTcg(game, cardId, from, to),
  ]);
  return {
    game, cardId: String(card.card_id), ctId: card.ct_id == null ? null : String(card.ct_id), from, to,
    printing: { name: card.name, setName: card.expansion_name, number: card.card_number },
    cardtrader: listed.status === 'fulfilled'
      ? cardtraderSource(listed.value.rows) : cardtraderSource([], 'unavailable'),
    tcgplayer: tcg.status === 'fulfilled'
      ? tcgplayerSource(tcg.value.observations)
      : tcgplayerSource([], tcg.reason?.statusCode === 503 && !process.env.TCGCSV_DATABASE_URL
        ? 'unconfigured' : 'unavailable'),
  };
}
module.exports = { parseRange, readCardPriceHistory, cardtraderSource, tcgplayerSource, CARD_SQL, LISTED_SQL };
