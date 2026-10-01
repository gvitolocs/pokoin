'use strict';

/**
 * PowerTools-style pricer for the MyPokoin listings board.
 *
 * GET /api/marketplace-price-check?items=<cardId[:COND:LANG],...>&excludeSellerUid=<uid>
 *
 * Per item, from live market data on the replica:
 *   pokoinCheapestPkn   — cheapest active native listing, caller's own rows excluded
 *   ctCheapestPkn       — cheapest live CardTrader ask in the complete book
 *   ctMatchedPkn        — cheapest CardTrader ask matching the item's condition + language
 *   soldMedianPkn       — 30-day inferred-sale median for the blueprint
 *
 * TCGplayer aggregate quotes come from the separate lossless TCGCSV store.
 * They retain USD, all printing variants and their source timestamp.
 */

// Sibling requires come from the live Pi release base (lazy so local unit
// tests can load the pure helpers without the Pi modules).
const queryDb = (...args) => require('./_marketplace_db').marketplaceQuery(...args);
const verifyBearer = (...args) => require('./_firebase').verifyBearerToken(...args);
const authError = (...args) => require('./_firebase').authErrorResponse(...args);

const MAX_ITEMS = 100;
const { readTcgplayerPrices } = require('./_tcgcsv_prices');

const CT_CONDITION_SETS = {
  NM: ['nm', 'mint', 'near mint', 'near mint foil'],
  SP: ['sp', 'slightly played', 'lightly played', 'lp', 'excellent', 'ex'],
  MP: ['mp', 'moderately played', 'played good', 'good', 'gd'],
  PL: ['pl', 'played', 'poor played'],
  Poor: ['poor', 'po', 'damaged', 'dmg'],
};

const CT_LANGUAGE_NAMES = {
  EN: ['english'],
  IT: ['italian'],
  DE: ['german'],
  FR: ['french'],
  ES: ['spanish'],
  JP: ['japanese'],
  KO: ['korean'],
  PT: ['portuguese'],
  NL: ['dutch'],
  PL: ['polish'],
  RU: ['russian'],
  ZH: ['chinese'],
  ZHT: ['chinese traditional', 'traditional chinese'],
};

/** "633380:NM:IT,713648" → [{ cardId, condition, language }] (≤ MAX_ITEMS). */
function parseItems(raw) {
  const items = [];
  const seen = new Set();
  for (const chunk of String(raw || '').split(',')) {
    const piece = chunk.trim();
    if (!piece) continue;
    const [rawId, rawCondition = '', rawLanguage = ''] = piece.split(':');
    const cardId = String(parseInt(rawId, 10) || '');
    if (!cardId || seen.has(piece.toUpperCase())) continue;
    seen.add(piece.toUpperCase());
    items.push({
      cardId,
      condition: String(rawCondition).trim().toUpperCase(),
      language: String(rawLanguage).trim().toUpperCase(),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** Cheapest CardTrader group matching the item's condition + language, else the overall low. */
function pickMatchedCt(groups = [], condition = '', language = '') {
  if (!groups.length) return { ctCheapestPkn: null, ctMatchedPkn: null };
  let cheapest = Infinity;
  let matched = Infinity;
  const wantCondition = CT_CONDITION_SETS[condition] || null;
  const wantLanguage = CT_LANGUAGE_NAMES[language] || (language ? [String(language).toLowerCase()] : null);
  for (const group of groups) {
    if (!(group.minPkn > 0)) continue;
    if (group.minPkn < cheapest) cheapest = group.minPkn;
    if (!wantCondition && !wantLanguage) continue;
    const condOk = !wantCondition || wantCondition.includes(String(group.condition || '').toLowerCase());
    const groupLang = String(group.language || '').toLowerCase();
    const langOk = !wantLanguage || wantLanguage.includes(groupLang) || groupLang === language.toLowerCase();
    if (condOk && langOk && group.minPkn < matched) matched = group.minPkn;
  }
  return {
    ctCheapestPkn: Number.isFinite(cheapest) ? Number(cheapest.toFixed(6)) : null,
    ctMatchedPkn: Number.isFinite(matched) ? Number(matched.toFixed(6)) : null,
  };
}

/** SQL condition-key normalization, mirroring the sold pipeline. */
const CONDITION_KEY_SQL = `
  case
    when lower(btrim(coalesce(condition, ''))) in ('nm', 'mint', 'near mint', 'near mint foil') then 'NM'
    when lower(btrim(coalesce(condition, ''))) in ('sp', 'slightly played', 'lightly played', 'lp', 'excellent', 'ex') then 'SP'
    when lower(btrim(coalesce(condition, ''))) in ('mp', 'moderately played', 'played good', 'good', 'gd') then 'MP'
    when lower(btrim(coalesce(condition, ''))) in ('pl', 'played', 'poor played') then 'PL'
    when lower(btrim(coalesce(condition, ''))) in ('poor', 'po', 'damaged', 'dmg') then 'Poor'
    else nullif(btrim(condition), '')
  end`;

/** CT language strings to the short codes the SPA sells in. */
const LANGUAGE_KEY_SQL = `
  case
    when lower(btrim(coalesce(language, ''))) in ('en', 'english') then 'EN'
    when lower(btrim(coalesce(language, ''))) in ('it', 'italian') then 'IT'
    when lower(btrim(coalesce(language, ''))) in ('de', 'german') then 'DE'
    when lower(btrim(coalesce(language, ''))) in ('fr', 'french') then 'FR'
    when lower(btrim(coalesce(language, ''))) in ('es', 'spanish') then 'ES'
    when lower(btrim(coalesce(language, ''))) in ('jp', 'ja', 'japanese') then 'JP'
    when lower(btrim(coalesce(language, ''))) in ('ko', 'kr', 'korean') then 'KO'
    when lower(btrim(coalesce(language, ''))) in ('pt', 'portuguese') then 'PT'
    when lower(btrim(coalesce(language, ''))) in ('nl', 'dutch') then 'NL'
    when lower(btrim(coalesce(language, ''))) in ('pl', 'polish') then 'PL'
    when lower(btrim(coalesce(language, ''))) in ('ru', 'russian') then 'RU'
    when lower(btrim(coalesce(language, ''))) in ('zh', 'zh-cn', 'zh_hans', 'zh-hans', 'chinese') then 'ZH'
    when lower(btrim(coalesce(language, ''))) in ('zh-tw', 'zht', 'zh_hant', 'zh-hant') then 'ZHT'
    else nullif(upper(btrim(language)), '')
  end`;

async function readPrices(items, { excludeSellerUid = '' } = {}) {
  const ids = [...new Set(items.map((item) => item.cardId))];
  if (!ids.length) return {};
  const ctIds = ids.map((id) => Math.floor(Number(id) / 2)).filter((id) => id > 0);

  const [pokoinRows, ctRows, soldRows] = await Promise.all([
    queryDb(
      `
        select card_id, min(price_pkn) as min_pkn
        from public.marketplace_user_listings
        where card_id = any($1::bigint[])
          and status = 'active'
          and quantity_available > 0
          and price_pkn > 0
          and ($2::text = '' or seller_uid is distinct from $2::text)
        group by card_id
      `,
      [ids, excludeSellerUid],
    ),
    queryDb(
      `
        select
          coalesce(blueprint_id, cardtrader_blueprint_id) as ct_id,
          ${CONDITION_KEY_SQL} as condition_key,
          ${LANGUAGE_KEY_SQL} as language_key,
          min(public.marketplace_price_pkn_from_cardtrader(price, price_cents, currency)) as min_pkn
        from public.cardtrader_market_listing_snapshots
        where coalesce(blueprint_id, cardtrader_blueprint_id) = any($1::bigint[])
          and quantity > 0
          and public.marketplace_price_pkn_from_cardtrader(price, price_cents, currency) > 0
        group by 1, 2, 3
      `,
      [ctIds],
    ),
    queryDb(
      `
        select blueprint_id,
               percentile_cont(0.5) within group (order by median_pkn) as sold_median_pkn
        from public.cardtrader_sold_daily
        where blueprint_id = any($1::bigint[])
          and observed_day >= current_date - 30
          and sold_qty > 0
          and median_pkn > 0
        group by blueprint_id
      `,
      [ids],
    ),
  ]).catch((error) => {
    error.statusCode = error.statusCode || 502;
    throw error;
  });

  const pokoinByCard = new Map(pokoinRows.rows.map((row) => [String(row.card_id), Number(row.min_pkn)]));
  const soldByCard = new Map(
    soldRows.rows.map((row) => [String(row.blueprint_id), Number(row.sold_median_pkn)]),
  );
  const ctByCard = new Map();
  for (const row of ctRows.rows) {
    const cardId = String(Number(row.ct_id) * 2);
    const groups = ctByCard.get(cardId) || [];
    groups.push({
      condition: row.condition_key,
      language: row.language_key,
      minPkn: Number(row.min_pkn),
    });
    ctByCard.set(cardId, groups);
  }

  const game = require('./_marketplace_game').currentGame();
  let tcgplayer;
  try {
    tcgplayer = await readTcgplayerPrices(game, ids);
  } catch (error) {
    console.error('TCGCSV price feed unavailable', error.code || error.message);
    tcgplayer = { status: 'unavailable', prices: {} };
  }
  const prices = {};
  for (const item of items) {
    const { ctCheapestPkn, ctMatchedPkn } = pickMatchedCt(ctByCard.get(item.cardId) || [], item.condition, item.language);
    prices[item.cardId] = {
      pokoinCheapestPkn: pokoinByCard.get(item.cardId) ?? null,
      ctCheapestPkn,
      ctMatchedPkn,
      soldMedianPkn: soldByCard.get(item.cardId) ?? null,
      tcgplayer: tcgplayer.prices[item.cardId] || [],
      tcgplayerStatus: tcgplayer.status,
    };
  }
  return prices;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearer(req);
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const items = parseItems(url.searchParams.get('items'));
    if (!items.length) {
      return res.status(400).json({ error: 'items query param required (cardId[:COND:LANG], max 100).' });
    }
    const prices = await readPrices(items, { excludeSellerUid: decoded.uid || '' });
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.status(200).json({ prices, source: 'pokoin+cardtrader', count: Object.keys(prices).length });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message || 'Price check failed.' });
    }
    console.error('marketplace-price-check failed', error);
    return res.status(500).json({ error: error.message || 'Price check failed.' });
  }
};

module.exports.parseItems = parseItems;
module.exports.pickMatchedCt = pickMatchedCt;
module.exports.readPrices = readPrices;
module.exports._test = { parseItems, pickMatchedCt, readPrices };
