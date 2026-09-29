'use strict';

/**
 * CardTrader deal scan — facet-perfect sold comps vs a seller's live listings.
 *
 * GET /api/cardtrader-deal-scan?seller=olivefrancesco10
 * GET /api/cardtrader-deal-scan?url=https://www.cardtrader.com/en-US/users/olivefrancesco10
 *
 * Auth: Bearer DEAL_SCAN_TOKEN (shared with the ct-deals Vercel proxy).
 *
 * Matching is hard: blueprint + condition + language + reverse + first_edition
 * + graded. No blueprint-wide / cross-language fallback for "crazy deals".
 */

const crypto = require('node:crypto');

const { marketplaceQuery } = require('./_marketplace_db');

const ROUTE_PATH = '/api/cardtrader-deal-scan';
const SOLD_WINDOW_DAYS = 90;
const MIN_SOLD_QTY = 3;
const CHEAP_SOLD_RATIO = 3;
const CHEAP_LIVE_RATIO = 2;
const EXPENSIVE_SOLD_RATIO = 4;
const EXPENSIVE_LIVE_RATIO = 3;
const MAX_DEALS_EACH = 100;

const CONDITION_MAP = [
  [/^(nm|near[ -]?mint|mint)$/i, 'NM'],
  [/^(sp|slightly[ -]?played|lightly[ -]?played)$/i, 'SP'],
  [/^(mp|played|moderately[ -]?played)$/i, 'MP'],
  [/^(pl|heavily[ -]?played|well[ -]?played|hp)$/i, 'PL'],
  [/^(poor|damaged)$/i, 'Poor'],
];

const LANGUAGE_MAP = [
  [/^(en|english)$/i, 'EN'],
  [/^(it|italian)$/i, 'IT'],
  [/^(fr|french)$/i, 'FR'],
  [/^(de|german)$/i, 'DE'],
  [/^(es|spanish)$/i, 'ES'],
  [/^(jp|ja|japanese)$/i, 'JP'],
  [/^(pt|portuguese)$/i, 'PT'],
  [/^(nl|dutch)$/i, 'NL'],
  [/^(pl|polish)$/i, 'PL'],
  [/^(ru|russian)$/i, 'RU'],
  [/^(ko|kr|korean)$/i, 'KO'],
  [/^(zh|zh-cn|chinese)$/i, 'ZH'],
  [/^(zht|zh-tw)$/i, 'ZHT'],
  [/^(id|indonesian)$/i, 'ID'],
];

function cleanText(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function normalizeCondition(value) {
  const text = cleanText(value, 60);
  if (!text) return 'NM';
  for (const [re, code] of CONDITION_MAP) {
    if (re.test(text)) return code;
  }
  return 'NM';
}

function normalizeLanguage(value) {
  const text = cleanText(value, 40);
  if (!text) return 'EN';
  for (const [re, code] of LANGUAGE_MAP) {
    if (re.test(text)) return code;
  }
  const upper = text.toUpperCase();
  const known = ['EN', 'IT', 'FR', 'DE', 'ES', 'JP', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT', 'ID'];
  return known.includes(upper) ? upper : 'EN';
}

/** Accept username or full CardTrader profile URL. */
function parseSellerInput({ seller, url }) {
  const raw = cleanText(url || seller, 300);
  if (!raw) return { ok: false, error: 'seller or url required' };
  const fromUrl = raw.match(/cardtrader\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?users\/([^/?#]+)/i);
  if (fromUrl) {
    return { ok: true, username: decodeURIComponent(fromUrl[1]) };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { ok: false, error: 'url must be a CardTrader /users/{username} profile' };
  }
  const username = raw.replace(/^@/, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
    return { ok: false, error: 'invalid CardTrader username' };
  }
  return { ok: true, username };
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function expectedToken() {
  return String(process.env.DEAL_SCAN_TOKEN || '').trim();
}

function isAuthorized(req) {
  const expected = expectedToken();
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''));
  if (!match) return false;
  return timingSafeEqualText(match[1].trim(), expected);
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

async function queryRows(text, values = []) {
  const result = await marketplaceQuery(text, values);
  return result?.rows ?? [];
}

/**
 * Resolve CT website username → snapshot seller_account_id.
 * CT display name often differs from the URL handle.
 */
async function resolveSellerAccount(username) {
  const byName = await queryRows(
    `select seller_account_id::text as account_id,
            seller_account_name as snapshot_name,
            count(*)::int as listing_count,
            coalesce(sum(quantity), 0)::int as quantity_sum
       from cardtrader_market_listing_snapshots
      where seller_account_name ilike $1
      group by 1, 2
      order by listing_count desc
      limit 1`,
    [username],
  );
  if (byName[0]) {
    return {
      username,
      accountId: byName[0].account_id,
      snapshotName: byName[0].snapshot_name,
      listingCount: byName[0].listing_count,
      quantitySum: byName[0].quantity_sum,
      resolvedVia: 'snapshot_name',
    };
  }

  let ctUserId = null;
  try {
    ctUserId = await fetchCardTraderUserId(username);
  } catch (error) {
    console.warn('cardtrader-deal-scan CT resolve failed', String(error?.message || error).slice(0, 200));
  }
  if (!ctUserId) return null;

  const byId = await queryRows(
    `select seller_account_id::text as account_id,
            seller_account_name as snapshot_name,
            count(*)::int as listing_count,
            coalesce(sum(quantity), 0)::int as quantity_sum
       from cardtrader_market_listing_snapshots
      where seller_account_id = $1
      group by 1, 2
      order by listing_count desc
      limit 1`,
    [String(ctUserId)],
  );
  if (!byId[0]) {
    return {
      username,
      accountId: String(ctUserId),
      snapshotName: null,
      listingCount: 0,
      quantitySum: 0,
      resolvedVia: 'cardtrader_user_id',
      missingFromSnapshots: true,
    };
  }
  return {
    username,
    accountId: byId[0].account_id,
    snapshotName: byId[0].snapshot_name,
    listingCount: byId[0].listing_count,
    quantitySum: byId[0].quantity_sum,
    resolvedVia: 'cardtrader_user_id',
  };
}

async function fetchCardTraderUserId(username) {
  const url = `https://www.cardtrader.com/en/users/${encodeURIComponent(username)}.json`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PokoinDealScan/1.0 (+https://pokoin.com)',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const body = await res.json();
  const id = body?.user?.id ?? body?.userId ?? body?.id;
  return id != null ? String(id) : null;
}

/**
 * Facet-perfect scan SQL. Condition/language normalized to sold_daily codes.
 * Outlier sold days clipped against the live book median.
 */
async function scanSellerDeals(accountId) {
  const rows = await queryRows(
    `with seller as (
       select
         s.blueprint_id::text as blueprint_id,
         s.price::numeric as ask_eur,
         s.quantity::int as quantity,
         coalesce(nullif(s.condition, ''), 'Near Mint') as condition_raw,
         lower(coalesce(nullif(s.language, ''), 'en')) as language_raw,
         coalesce((s.properties->>'pokemon_reverse')::boolean, false) as reverse,
         coalesce((s.properties->>'first_edition')::boolean, false) as first_edition,
         false as graded,
         case
           when lower(coalesce(s.condition, '')) ~ '^(nm|near[ -]?mint|mint)$' then 'NM'
           when lower(coalesce(s.condition, '')) ~ '^(sp|slightly[ -]?played|lightly[ -]?played)$' then 'SP'
           when lower(coalesce(s.condition, '')) ~ '^(mp|played|moderately[ -]?played)$' then 'MP'
           when lower(coalesce(s.condition, '')) ~ '^(pl|heavily[ -]?played|well[ -]?played|hp)$' then 'PL'
           when lower(coalesce(s.condition, '')) ~ '^(poor|damaged)$' then 'Poor'
           else 'NM'
         end as condition_code,
         case
           when lower(coalesce(s.language, '')) in ('it', 'italian') then 'IT'
           when lower(coalesce(s.language, '')) in ('fr', 'french') then 'FR'
           when lower(coalesce(s.language, '')) in ('de', 'german') then 'DE'
           when lower(coalesce(s.language, '')) in ('es', 'spanish') then 'ES'
           when lower(coalesce(s.language, '')) in ('jp', 'ja', 'japanese') then 'JP'
           when lower(coalesce(s.language, '')) in ('pt', 'portuguese') then 'PT'
           when lower(coalesce(s.language, '')) in ('nl', 'dutch') then 'NL'
           when lower(coalesce(s.language, '')) in ('pl', 'polish') then 'PL'
           when lower(coalesce(s.language, '')) in ('ru', 'russian') then 'RU'
           when lower(coalesce(s.language, '')) in ('ko', 'kr', 'korean') then 'KO'
           when lower(coalesce(s.language, '')) in ('zh', 'zh-cn', 'chinese') then 'ZH'
           when lower(coalesce(s.language, '')) in ('zht', 'zh-tw') then 'ZHT'
           when lower(coalesce(s.language, '')) in ('id', 'indonesian') then 'ID'
           when coalesce(s.language, '') = '' then 'EN'
           when lower(coalesce(s.language, '')) in ('en', 'english') then 'EN'
           else 'EN'
         end as language_code
       from cardtrader_market_listing_snapshots s
       where s.seller_account_id = $1
     ),
     named as (
       select distinct on (
         seller.blueprint_id, seller.condition_code, seller.language_code,
         seller.reverse, seller.first_edition, seller.ask_eur
       )
         seller.*,
         c.name as card_name,
         c.expansion_name,
         c.card_number,
         c.card_id
       from seller
       left join marketplace_search_candidates c
         on c.ct_id::text = seller.blueprint_id
       order by
         seller.blueprint_id, seller.condition_code, seller.language_code,
         seller.reverse, seller.first_edition, seller.ask_eur, c.card_id
     ),
     live as (
       select
         blueprint_id::text as blueprint_id,
         min(price::numeric) filter (where price::numeric > 0) as live_cheapest_eur,
         percentile_cont(0.5) within group (order by price::numeric)
           filter (where price::numeric > 0) as live_median_eur,
         count(*) filter (where price::numeric > 0)::int as live_listing_count
       from cardtrader_market_listing_snapshots
       where blueprint_id::text in (select distinct blueprint_id from seller)
       group by 1
     ),
     sold_days as (
       select
         d.blueprint_id::text as blueprint_id,
         d.condition as condition_code,
         upper(coalesce(nullif(d.language, ''), 'EN')) as language_code,
         d.reverse,
         d.first_edition,
         d.graded,
         d.observed_day,
         d.median_pkn * 0.005 as day_eur,
         d.sold_qty
       from cardtrader_sold_daily d
       where d.observed_day >= (current_date - ($2::int || ' days')::interval)
         and d.blueprint_id::text in (select distinct blueprint_id from seller)
         and d.sold_qty > 0
     ),
     sold_clean as (
       select sd.*
       from sold_days sd
       join live l on l.blueprint_id = sd.blueprint_id
       where sd.day_eur > 0
         and sd.day_eur <= 500
         and (l.live_median_eur is null or sd.day_eur <= greatest(l.live_median_eur * 25, 5))
     ),
     sold_facet as (
       select
         blueprint_id,
         condition_code,
         language_code,
         reverse,
         first_edition,
         graded,
         percentile_cont(0.5) within group (order by day_eur) as sold_median_eur,
         sum(sold_qty)::int as sold_qty_90d,
         count(*)::int as sold_day_rows,
         max(observed_day) as last_sold_day
       from sold_clean
       group by 1, 2, 3, 4, 5, 6
     ),
     joined as (
       select
         n.*,
         l.live_cheapest_eur,
         l.live_median_eur,
         l.live_listing_count,
         sf.sold_median_eur,
         sf.sold_qty_90d,
         sf.sold_day_rows,
         sf.last_sold_day
       from named n
       left join live l on l.blueprint_id = n.blueprint_id
       left join sold_facet sf
         on sf.blueprint_id = n.blueprint_id
        and sf.condition_code = n.condition_code
        and sf.language_code = n.language_code
        and sf.reverse = n.reverse
        and sf.first_edition = n.first_edition
        and sf.graded = n.graded
     )
     select
       blueprint_id,
       card_id,
       coalesce(card_name, '(unknown)') as card_name,
       coalesce(expansion_name, '') as expansion_name,
       coalesce(card_number, '') as card_number,
       condition_raw,
       condition_code,
       language_raw,
       language_code,
       reverse,
       first_edition,
       graded,
       round(ask_eur, 2) as ask_eur,
       quantity,
       round(sold_median_eur::numeric, 2) as sold_median_eur,
       round(live_cheapest_eur::numeric, 2) as live_cheapest_eur,
       round(live_median_eur::numeric, 2) as live_median_eur,
       coalesce(live_listing_count, 0) as live_listing_count,
       coalesce(sold_qty_90d, 0) as sold_qty_90d,
       last_sold_day,
       case
         when sold_median_eur is null then 'no_sold_match'
         when sold_qty_90d < $3 then 'thin_sold'
         when ask_eur > 0
           and sold_median_eur / ask_eur >= $4
           and live_median_eur is not null
           and live_median_eur / ask_eur >= $5
           then 'cheap_vs_sold'
         when ask_eur > 0
           and sold_median_eur > 0
           and ask_eur / sold_median_eur >= $6
           and live_median_eur is not null
           and ask_eur / live_median_eur >= $7
           then 'expensive_vs_sold'
         else 'ok'
       end as flag,
       case
         when sold_median_eur is null or ask_eur <= 0 then null
         else round((sold_median_eur / ask_eur)::numeric, 2)
       end as sold_over_ask,
       case
         when sold_median_eur is null or sold_median_eur <= 0 then null
         else round((ask_eur / sold_median_eur)::numeric, 2)
       end as ask_over_sold
     from joined
     order by
       case
         when sold_median_eur is not null and ask_eur > 0 and sold_median_eur / ask_eur >= $4
           then sold_median_eur / ask_eur
         when sold_median_eur is not null and sold_median_eur > 0 and ask_eur / sold_median_eur >= $6
           then ask_eur / sold_median_eur
         else 0
       end desc`,
    [
      String(accountId),
      SOLD_WINDOW_DAYS,
      MIN_SOLD_QTY,
      CHEAP_SOLD_RATIO,
      CHEAP_LIVE_RATIO,
      EXPENSIVE_SOLD_RATIO,
      EXPENSIVE_LIVE_RATIO,
    ],
  );
  return rows;
}

function dealDto(row) {
  return {
    blueprintId: String(row.blueprint_id),
    cardId: row.card_id != null ? String(row.card_id) : null,
    cardName: row.card_name,
    expansionName: row.expansion_name,
    cardNumber: row.card_number,
    condition: row.condition_code,
    conditionRaw: row.condition_raw,
    language: row.language_code,
    languageRaw: row.language_raw,
    reverse: Boolean(row.reverse),
    firstEdition: Boolean(row.first_edition),
    graded: Boolean(row.graded),
    askEur: Number(row.ask_eur),
    quantity: Number(row.quantity) || 0,
    soldMedianEur: row.sold_median_eur != null ? Number(row.sold_median_eur) : null,
    liveCheapestEur: row.live_cheapest_eur != null ? Number(row.live_cheapest_eur) : null,
    liveMedianEur: row.live_median_eur != null ? Number(row.live_median_eur) : null,
    liveListingCount: Number(row.live_listing_count) || 0,
    soldQty90d: Number(row.sold_qty_90d) || 0,
    lastSoldDay: row.last_sold_day ? String(row.last_sold_day).slice(0, 10) : null,
    flag: row.flag,
    soldOverAsk: row.sold_over_ask != null ? Number(row.sold_over_ask) : null,
    askOverSold: row.ask_over_sold != null ? Number(row.ask_over_sold) : null,
    pokoinUrl: row.card_id ? `https://pokoin.com/${row.card_id}` : null,
  };
}

function classifyDeals(rows) {
  const cheap = [];
  const expensive = [];
  let unmatched = 0;
  let thinSold = 0;
  let ok = 0;
  for (const row of rows) {
    if (row.flag === 'cheap_vs_sold') {
      if (cheap.length < MAX_DEALS_EACH) cheap.push(dealDto(row));
    } else if (row.flag === 'expensive_vs_sold') {
      if (expensive.length < MAX_DEALS_EACH) expensive.push(dealDto(row));
    } else if (row.flag === 'no_sold_match') unmatched += 1;
    else if (row.flag === 'thin_sold') thinSold += 1;
    else ok += 1;
  }
  cheap.sort((a, b) => (b.soldOverAsk || 0) - (a.soldOverAsk || 0));
  expensive.sort((a, b) => (b.askOverSold || 0) - (a.askOverSold || 0));
  return { cheap, expensive, unmatched, thinSold, ok };
}

module.exports = async function handler(req, res) {
  try {
    if (!expectedToken()) {
      return sendJson(res, 503, { ok: false, error: 'deal-scan not configured: DEAL_SCAN_TOKEN missing' });
    }
    if (!isAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'GET only' });
    }

    const url = new URL(req.url, `https://${req.headers.host || 'api.pokoin.com'}`);
    const parsed = parseSellerInput({
      seller: url.searchParams.get('seller'),
      url: url.searchParams.get('url'),
    });
    if (!parsed.ok) {
      return sendJson(res, 400, { ok: false, error: parsed.error });
    }

    const seller = await resolveSellerAccount(parsed.username);
    if (!seller) {
      return sendJson(res, 404, {
        ok: false,
        error: `seller not found: ${parsed.username}`,
        username: parsed.username,
      });
    }
    if (seller.missingFromSnapshots || seller.listingCount === 0) {
      return sendJson(res, 404, {
        ok: false,
        error: 'seller has no listings in the current CardTrader snapshot book',
        seller: {
          username: seller.username,
          accountId: seller.accountId,
          snapshotName: seller.snapshotName,
          listingCount: 0,
          resolvedVia: seller.resolvedVia,
        },
      });
    }

    const rows = await scanSellerDeals(seller.accountId);
    const deals = classifyDeals(rows);

    return sendJson(res, 200, {
      ok: true,
      product: 'cardtrader_deal_scan',
      match: 'facet_perfect',
      matchFields: ['blueprint_id', 'condition', 'language', 'reverse', 'first_edition', 'graded'],
      soldWindowDays: SOLD_WINDOW_DAYS,
      minSoldQty: MIN_SOLD_QTY,
      gates: {
        cheap: { soldOverAsk: CHEAP_SOLD_RATIO, liveMedianOverAsk: CHEAP_LIVE_RATIO },
        expensive: { askOverSold: EXPENSIVE_SOLD_RATIO, askOverLiveMedian: EXPENSIVE_LIVE_RATIO },
      },
      seller: {
        username: seller.username,
        accountId: seller.accountId,
        snapshotName: seller.snapshotName,
        listingCount: seller.listingCount,
        quantitySum: seller.quantitySum,
        resolvedVia: seller.resolvedVia,
        profileUrl: `https://www.cardtrader.com/en/users/${encodeURIComponent(seller.username)}`,
      },
      scannedListings: rows.length,
      unmatchedCount: deals.unmatched,
      thinSoldCount: deals.thinSold,
      okCount: deals.ok,
      deals: {
        cheap: deals.cheap,
        expensive: deals.expensive,
      },
    });
  } catch (error) {
    console.error('cardtrader-deal-scan', error);
    return sendJson(res, 500, { ok: false, error: 'deal scan failed' });
  }
};

module.exports._test = {
  ROUTE_PATH,
  SOLD_WINDOW_DAYS,
  MIN_SOLD_QTY,
  CHEAP_SOLD_RATIO,
  EXPENSIVE_SOLD_RATIO,
  cleanText,
  normalizeCondition,
  normalizeLanguage,
  parseSellerInput,
  classifyDeals,
  dealDto,
  timingSafeEqualText,
};
