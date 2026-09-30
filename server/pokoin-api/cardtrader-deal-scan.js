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
 * Prefer CardTrader user id (indexed); avoid ILIKE on the full snapshot table.
 */
async function resolveSellerAccount(username) {
  // Exact display-name hit (rare when URL handle == snapshot name).
  const byExact = await queryRows(
    `select seller_account_id::text as account_id,
            seller_account_name as snapshot_name,
            count(*)::int as listing_count,
            coalesce(sum(quantity), 0)::int as quantity_sum
       from cardtrader_market_listing_snapshots
      where seller_account_name = $1
      group by 1, 2
      order by listing_count desc
      limit 1`,
    [username],
  );
  if (byExact[0]) {
    return {
      username,
      accountId: byExact[0].account_id,
      snapshotName: byExact[0].snapshot_name,
      listingCount: byExact[0].listing_count,
      quantitySum: byExact[0].quantity_sum,
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
 * Facet-perfect scan in indexed steps (seller listings → live book → sold facets).
 * Avoids a single mega-join that times out on large sellers (~30s statement_timeout).
 */
async function scanSellerDeals(accountId) {
  const listings = await queryRows(
    `select distinct on (
        s.blueprint_id::text,
        coalesce(nullif(s.condition, ''), 'Near Mint'),
        lower(coalesce(nullif(s.language, ''), 'en')),
        coalesce((s.properties->>'pokemon_reverse')::boolean, false),
        coalesce((s.properties->>'first_edition')::boolean, false),
        s.price::numeric
      )
        s.blueprint_id::text as blueprint_id,
        s.price::numeric as ask_eur,
        s.quantity::int as quantity,
        coalesce(nullif(s.condition, ''), 'Near Mint') as condition_raw,
        lower(coalesce(nullif(s.language, ''), 'en')) as language_raw,
        coalesce((s.properties->>'pokemon_reverse')::boolean, false) as reverse,
        coalesce((s.properties->>'first_edition')::boolean, false) as first_edition,
        false as graded,
        c.name as card_name,
        c.expansion_name,
        c.card_number,
        c.card_id
      from cardtrader_market_listing_snapshots s
      left join marketplace_search_candidates c
        on c.ct_id::text = s.blueprint_id::text
     where s.seller_account_id = $1
       and s.price::numeric > 0
     order by
        s.blueprint_id::text,
        coalesce(nullif(s.condition, ''), 'Near Mint'),
        lower(coalesce(nullif(s.language, ''), 'en')),
        coalesce((s.properties->>'pokemon_reverse')::boolean, false),
        coalesce((s.properties->>'first_edition')::boolean, false),
        s.price::numeric,
        c.card_id`,
    [String(accountId)],
  );

  if (!listings.length) return [];

  const blueprintIds = [...new Set(listings.map((row) => String(row.blueprint_id)))];

  // Live book from snapshots (indexed ANY; ~1s for ~2.5k blueprints).
  const liveRows = await queryRows(
    `select blueprint_id::text as blueprint_id,
            min(price::numeric) as live_cheapest_eur,
            percentile_cont(0.5) within group (order by price::numeric) as live_median_eur,
            count(*)::int as live_listing_count
       from cardtrader_market_listing_snapshots
      where blueprint_id = any($1::bigint[])
        and price::numeric > 0
      group by 1`,
    [blueprintIds],
  );

  const liveByBp = new Map();
  for (const row of liveRows) {
    liveByBp.set(String(row.blueprint_id), {
      live_cheapest_eur: row.live_cheapest_eur != null ? Number(row.live_cheapest_eur) : null,
      live_median_eur: row.live_median_eur != null ? Number(row.live_median_eur) : null,
      live_listing_count: Number(row.live_listing_count) || 0,
    });
  }

  const soldRows = await queryRows(
    `with sold_days as (
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
        and d.blueprint_id = any($1::bigint[])
        and d.sold_qty > 0
        and d.median_pkn * 0.005 > 0
        and d.median_pkn * 0.005 <= 500
     )
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
     from sold_days
     group by 1, 2, 3, 4, 5, 6`,
    [blueprintIds, SOLD_WINDOW_DAYS],
  );

  const soldByFacet = new Map();
  for (const row of soldRows) {
    const key = [
      String(row.blueprint_id),
      row.condition_code,
      row.language_code,
      row.reverse ? '1' : '0',
      row.first_edition ? '1' : '0',
      row.graded ? '1' : '0',
    ].join('|');
    soldByFacet.set(key, row);
  }

  const out = [];
  for (const listing of listings) {
    const condition_code = normalizeCondition(listing.condition_raw);
    const language_code = normalizeLanguage(listing.language_raw);
    const ask = Number(listing.ask_eur);
    const live = liveByBp.get(String(listing.blueprint_id)) || {};
    let liveMedian = live.live_median_eur ?? null;
    let liveCheapest = live.live_cheapest_eur ?? null;

    const facetKey = [
      String(listing.blueprint_id),
      condition_code,
      language_code,
      listing.reverse ? '1' : '0',
      listing.first_edition ? '1' : '0',
      '0',
    ].join('|');
    const sold = soldByFacet.get(facetKey);

    let soldMedian = sold?.sold_median_eur != null ? Number(sold.sold_median_eur) : null;
    const soldQty = sold?.sold_qty_90d != null ? Number(sold.sold_qty_90d) : 0;
    // Drop absurd sold medians vs live book (same clip idea as the olive scan).
    if (soldMedian != null && liveMedian != null && soldMedian > Math.max(liveMedian * 25, 5)) {
      soldMedian = null;
    }

    let flag = 'ok';
    if (soldMedian == null) flag = 'no_sold_match';
    else if (soldQty < MIN_SOLD_QTY) flag = 'thin_sold';
    else if (
      ask > 0
      && soldMedian / ask >= CHEAP_SOLD_RATIO
      && liveMedian != null
      && liveMedian / ask >= CHEAP_LIVE_RATIO
    ) {
      flag = 'cheap_vs_sold';
    } else if (
      ask > 0
      && soldMedian > 0
      && ask / soldMedian >= EXPENSIVE_SOLD_RATIO
      && liveMedian != null
      && ask / liveMedian >= EXPENSIVE_LIVE_RATIO
    ) {
      flag = 'expensive_vs_sold';
    }

    out.push({
      blueprint_id: listing.blueprint_id,
      card_id: listing.card_id,
      card_name: listing.card_name || '(unknown)',
      expansion_name: listing.expansion_name || '',
      card_number: listing.card_number || '',
      condition_raw: listing.condition_raw,
      condition_code,
      language_raw: listing.language_raw,
      language_code,
      reverse: Boolean(listing.reverse),
      first_edition: Boolean(listing.first_edition),
      graded: false,
      ask_eur: Math.round(ask * 100) / 100,
      quantity: Number(listing.quantity) || 0,
      sold_median_eur: soldMedian != null ? Math.round(soldMedian * 100) / 100 : null,
      live_cheapest_eur: liveCheapest != null ? Math.round(liveCheapest * 100) / 100 : null,
      live_median_eur: liveMedian != null ? Math.round(liveMedian * 100) / 100 : null,
      live_listing_count: live.live_listing_count || 0,
      sold_qty_90d: soldQty,
      last_sold_day: sold?.last_sold_day || null,
      flag,
      sold_over_ask: soldMedian != null && ask > 0 ? Math.round((soldMedian / ask) * 100) / 100 : null,
      ask_over_sold: soldMedian != null && soldMedian > 0 ? Math.round((ask / soldMedian) * 100) / 100 : null,
    });
  }

  out.sort((a, b) => {
    const score = (row) => {
      if (row.flag === 'cheap_vs_sold') return row.sold_over_ask || 0;
      if (row.flag === 'expensive_vs_sold') return row.ask_over_sold || 0;
      return 0;
    };
    return score(b) - score(a);
  });
  return out;
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
