'use strict';

let pool;
let historyPool;
function poolOptions(history = false) {
  return { connectionString: process.env.TCGCSV_DATABASE_URL, max: history ? 1 : 2,
    connectionTimeoutMillis: 5000, statement_timeout: history ? 15000 : 5000,
    application_name: history ? 'pokoin-tcgcsv-history' : 'pokoin-tcgcsv-prices',
    ssl: process.env.TCGCSV_DATABASE_SSL === '0' ? false : { rejectUnauthorized: true } };
}
function getPool(history = false) {
  if (!process.env.TCGCSV_DATABASE_URL) return null;
  if (history ? !historyPool : !pool) {
    const { Pool } = require('pg');
    // Older indexed history is on the 15 TB HDD. Give cold heap reads a bounded
    // 15 seconds without slowing current-price requests or increasing concurrency.
    if (history) historyPool = new Pool(poolOptions(true));
    else pool = new Pool(poolOptions(false));
  }
  return history ? historyPool : pool;
}

// Preserve every mapped product and subtype; condition/language-specific quotes
// cannot be inferred from the TCGCSV aggregate prices.
function groupPrices(rows) {
  const result = {};
  for (const row of rows) {
    const id = String(row.card_id);
    (result[id] ||= []).push({
      productId: String(row.product_id), categoryId: row.category_id,
      groupId: row.group_id, subtype: row.subtype, gameName: row.game_name,
      setName: row.set_name, name: row.name, currency: 'USD',
      marketPrice: row.market_price, lowPrice: row.low_price, midPrice: row.mid_price,
      highPrice: row.high_price, directLowPrice: row.direct_low_price,
      sourceTimestamp: row.snapshot_timestamp, rawData: row.raw_data,
      conditionSpecific: false, source: 'tcgcsv/tcgplayer',
      languageSpecific: false,
    });
  }
  return result;
}

async function readTcgplayerPrices(game, ids, query) {
  if (!ids.length) return { status: 'empty', prices: {} };
  if (!query) {
    const client = getPool();
    if (!client) return { status: 'unconfigured', prices: {} };
    query = (...args) => client.query(...args);
  }
  const result = await query(`SELECT * FROM pokoin_tcgplayer_latest
    WHERE game=$1 AND card_id=ANY($2::bigint[])
    ORDER BY card_id,category_id,product_id,subtype`, [game, ids]);
  return { status: 'available', prices: groupPrices(result.rows) };
}

async function readTcgplayerHistory(game, cardId, from, to, query) {
  if (!query) {
    const client = getPool(true);
    if (!client) { const error = new Error('TCGplayer history unavailable.'); error.statusCode=503; throw error; }
    query = (...args) => client.query(...args);
  }
  const mapped = await query(`SELECT DISTINCT l.product_id,p.category_id
    FROM pokoin_product_links l LEFT JOIN latest_prices p USING(product_id)
    WHERE l.active AND l.game=$1 AND l.card_id=$2::bigint`,[game,cardId]);
  const products = [...new Set(mapped.rows.map((row) => String(row.product_id)))];
  // Category-leading history indexes require an explicit category predicate.
  // Include both archive categories even when an older product is no longer
  // present in the current source catalog.
  const categories = [...new Set([3,85,...mapped.rows.map((row)=>row.category_id).filter(Boolean)])];
  const result = products.length ? await query(`SELECT p.* FROM all_daily_prices p
    WHERE product_id=ANY($1::bigint[]) AND category_id=ANY($2::integer[])
      AND observed_on BETWEEN $3::date AND $4::date
    ORDER BY observed_on,category_id,product_id,subtype`,[products,categories,from,to]) : {rows:[]};
  return {source:'tcgcsv/tcgplayer',currency:'USD',conditionSpecific:false,
    languageSpecific:false,game,cardId,from,to,observations:result.rows};
}

async function readTcgplayerProductId(game, cardId, query) {
  const id = String(cardId || '').replace(/\D/g, '');
  if (!id) return '';
  if (!query) {
    const client = getPool();
    if (!client) {
      const error = new Error('TCGplayer links unavailable.');
      error.statusCode = 503;
      throw error;
    }
    query = (...args) => client.query(...args);
  }
  const result = await query(
    `SELECT product_id::text AS product_id
     FROM pokoin_product_links
     WHERE active AND game = $1 AND card_id = $2::bigint
     ORDER BY last_seen DESC NULLS LAST, product_id
     LIMIT 1`,
    [game, id],
  );
  return result.rows[0]?.product_id ? String(result.rows[0].product_id) : '';
}

module.exports = { readTcgplayerPrices, readTcgplayerHistory, readTcgplayerProductId, groupPrices, poolOptions };
