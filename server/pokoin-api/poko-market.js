'use strict';

/**
 * Poko Market Intelligence — read-only card-market tools for the Poko assistant.
 *
 * Canonical source for the Pi overlay. Deploy with
 * `scripts/deploy-poko-market-api.sh` from an origin/main commit. Poko channels
 * (website chat, Telegram, YouTube replies) all consume this same contract via
 * server-to-server auth; the browser never sees the service token.
 *
 * Tools (POST /api/poko-market with { tool, params }):
 *   resolve_card     — fuzzy card resolution; returns candidates from the
 *                      catalog only, never an invented card id.
 *   card_quote       — sold-market estimate from sanitized cardtrader_sold_daily,
 *                      per variant (standard / 1st Ed. / reverse / graded never
 *                      mixed), all conditions+languages unless stated, plus
 *                      live asks from the same slice.
 *   card_sales       — dated sold history + 7/30/90-day totals for a card.
 *   deal_check       — cheapest live asks vs same-slice sold medians
 *                      ("should I buy it?").
 *   set_sales        — expansion-level sold totals and top cards.
 *   recent_sales     — latest / priciest sales market-wide, filterable.
 *   card_liquidity   — deterministic sell-time range from marketplace_card_weights.
 *   collection_quote — artist-level collection estimate with explicit coverage.
 *   market_snapshot  — top sold_qty_7d cards (public aggregates only).
 *   top_movers       — biggest dated ask-price moves for a subject ("which
 *                      Raikou card rose the most?").
 *   top_sellers      — most-sold singles over a window, filterable by
 *                      language / rarity / price ("most liquid JP cards
 *                      over €10").
 *   artist_cards     — an artist's singles ranked by price or sales; the
 *                      artist can come from a cardId ("this artist").
 *   set_info         — expansion era / nationality / release languages /
 *                      localized names / card counts.
 *   card_ocr         — approximate western leftover OCR (attacks/rules/HP)
 *                      from marketplace_card_ocr; never invent card text.
 *
 * Privacy boundary: the SQL in this file selects public aggregates only. Fields
 * like seller_uid, buyer_uid, emails, addresses or account ids are never part
 * of any result DTO, so they cannot leak through Poko regardless of prompts.
 *
 * Sibling requires (`_marketplace_db`) come from the live Pi release base.
 */

const crypto = require('node:crypto');

const { marketplaceQuery } = require('./_marketplace_db');

// marketplaceQuery resolves to the pg QueryResult; the tools want rows.
async function queryRows(text, values = []) {
  const result = await marketplaceQuery(text, values);
  return result?.rows ?? [];
}

const ROUTE_PATH = '/api/poko-market';

// CardTrader condition scale used by cardtrader_sold_daily (schema 042).
const CONDITIONS = ['NM', 'SP', 'MP', 'PL', 'Poor'];

// Language codes accepted by cardtrader_sold_daily (schema 042 normalizer).
const LANGUAGES = ['EN', 'IT', 'FR', 'DE', 'ES', 'JP', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT', 'ID'];

const CONDITION_MAP = [
  [/^(nm|near[ -]?mint|mint|pretty clean|mint condition)$/i, 'NM'],
  [/^(sp|slightly[ -]?played|lightly[ -]?played|light play)$/i, 'SP'],
  [/^(mp|played|moderately[ -]?played|moderate play)$/i, 'MP'],
  [/^(pl|heavily[ -]?played|well[ -]?played|hp|quite played)$/i, 'PL'],
  [/^(poor|damaged|very[ -]?damaged|really[ -]?damaged|badly[ -]?damaged)$/i, 'Poor'],
];

// Vague wear phrasings must not be promoted to NM; return a range instead.
const VAGUE_CONDITION_RES = [
  /a bit (damaged|played|worn)/i,
  /a little (damaged|played|worn)/i,
  /some wear/i,
  /slight(ly)? (wear|damage)/i,
  /un po' (roviniata|usata)/i,
];

const LANGUAGE_MAP = [
  [/^(en|english|inglese)$/i, 'EN'],
  [/^(it|italian|italiano)$/i, 'IT'],
  [/^(fr|french|francese)$/i, 'FR'],
  [/^(de|german|tedesco)$/i, 'DE'],
  [/^(es|spanish|spagnolo)$/i, 'ES'],
  [/^(jp|ja|japanese|giapponese)$/i, 'JP'],
  [/^(pt|portuguese|portoghese)$/i, 'PT'],
  [/^(nl|dutch|olandese)$/i, 'NL'],
  [/^(pl|polish|polacco)$/i, 'PL'],
  [/^(ru|russian|russo)$/i, 'RU'],
  [/^(ko|korean|coreano)$/i, 'KO'],
  [/^(zh|chinese|cinese)$/i, 'ZH'],
  [/^(zht|traditional chinese|cinese tradizionale)$/i, 'ZHT'],
  [/^(id|indonesian|indonesiano)$/i, 'ID'],
];

const MAX_COLLECTION_CARDS = 500;

// Weights refresh daily via listing-weights.timer. If the pipeline stalls,
// days_of_supply goes quietly stale — better to fall back to fresh sold data
// than quote bands from a two-week-old snapshot.
const FRESH_WEIGHTS_MAX_AGE_DAYS = 3;

function weightsAreFresh(updatedAt) {
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) / 86_400_000 <= FRESH_WEIGHTS_MAX_AGE_DAYS;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function cleanText(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function escapeLike(value) {
  return cleanText(value, 120).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Subsequence fuzzy pattern over [a-z0-9] only, e.g. "Yukamori" → %y%u%k%a%m%o%r%i%. */
function fuzzyArtistPattern(value) {
  const chars = cleanText(value, 60).toLowerCase().replace(/[^a-z0-9]/g, '').split('');
  if (!chars.length) return '';
  return `%${chars.join('%')}%`;
}

function normalizeCondition(value) {
  const text = cleanText(value, 60);
  if (!text) return { primary: 'NM', alternatives: [], vague: false, matched: false };
  for (const [re, code] of CONDITION_MAP) {
    if (re.test(text)) return { primary: code, alternatives: [], vague: false, matched: true };
  }
  if (VAGUE_CONDITION_RES.some((re) => re.test(text))) {
    return { primary: 'MP', alternatives: ['PL', 'Poor'], vague: true, matched: true };
  }
  return { primary: 'NM', alternatives: [], vague: false, matched: false };
}

function normalizeLanguage(value) {
  const text = cleanText(value, 40);
  if (!text) return { code: 'EN', matched: false };
  for (const [re, code] of LANGUAGE_MAP) {
    if (re.test(text)) return { code, matched: true };
  }
  const upper = text.toUpperCase();
  return { code: LANGUAGES.includes(upper) ? upper : 'EN', matched: LANGUAGES.includes(upper) };
}

/** Public card ids for singles are CardTrader blueprint ids × 2 (pokoin_public_card_id). */
function blueprintIdFromCardId(cardId) {
  const num = Number(cardId);
  if (!Number.isInteger(num) || num <= 0 || num % 2 !== 0) return null;
  return num / 2;
}

function confidenceForSample(sampleSize) {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) return 'none';
  if (sampleSize >= 10) return 'high';
  if (sampleSize >= 4) return 'medium';
  return 'low';
}

function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

/**
 * Deterministic sell-time band. Uses weights days_of_supply when present,
 * else a sell-through heuristic from sold_qty_7d vs active supply. Never a
 * guarantee — always returned with methodology + confidence.
 */
function liquidityBands({ daysOfSupply, soldQty7d, listedNow }) {
  const days = Number(daysOfSupply);
  if (Number.isFinite(days) && days > 0) {
    return {
      lowDays: Math.max(1, Math.round(days * 0.4)),
      typicalDays: Math.round(days),
      highDays: Math.round(days * 2.5),
      methodology: 'days_of_supply from marketplace_card_weights',
      confidence: 'medium',
    };
  }
  const sold = Number(soldQty7d);
  const listed = Number(listedNow);
  if (Number.isFinite(sold) && sold > 0 && Number.isFinite(listed) && listed > 0) {
    const typical = Math.round((listed / sold) * 7);
    return {
      lowDays: Math.max(1, Math.round(typical * 0.4)),
      typicalDays: typical,
      highDays: Math.round(typical * 2.5),
      methodology: 'sell-through: active supply ÷ sold_qty_7d',
      confidence: 'low',
    };
  }
  return null;
}

/** Overall estimate rolled up from one row of daily-median percentiles. */
function buildSoldSummary(row) {
  if (!row || !(Number(row.sold_qty) > 0)) return null;
  const median = round2(row.median_daily);
  const p25 = round2(row.p25_daily);
  const p75 = round2(row.p75_daily);
  return {
    currency: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    median: median,
    p25: p25,
    p75: p75,
    sampleSize: Number(row.sold_qty) || 0,
    lastSaleDay: row.last_sale_day ? String(row.last_sale_day).slice(0, 10) : null,
    methodology: 'median of daily sold medians (cardtrader_sold_daily, sanitized inferred sales)',
    confidence: confidenceForSample(Number(row.sold_qty)),
  };
}

function timeRange(fromDays, toDays) {
  const from = Math.max(1, Math.round(fromDays));
  const to = Math.max(from, Math.round(toDays));
  if (to <= 21) return `${from}-${to}d`;
  return `${Math.max(1, Math.round(from / 7))}-${Math.max(1, Math.round(to / 7))}w`;
}

/**
 * Sell-price ladder. Times come from the card's own liquidity bands when
 * known: fixed 1-3 week labels told users a Raikou ex that typically sells in
 * 3 days (1-8) would take weeks at the median.
 */
function priceStrategies(summary, asks, liquidity = null) {
  if (!summary || summary.confidence === 'none' || summary.confidence === 'low') return null;
  const minAsk = asks && asks.min != null ? asks.min : null;
  const quick = minAsk != null ? Math.min(summary.p25 ?? summary.median, minAsk * 0.95) : summary.p25 ?? summary.median;
  const low = Number(liquidity?.lowDays);
  const typical = Number(liquidity?.typicalDays);
  const high = Number(liquidity?.highDays);
  const banded = low > 0 && typical > 0 && high > 0;
  return {
    quickSale: { price: round2(quick), expectedTime: banded ? timeRange(low, typical) : '1-7d' },
    market: { price: summary.median, expectedTime: banded ? timeRange(typical, high) : '1-3w' },
    patient: { price: summary.p75 ?? summary.median, expectedTime: banded ? timeRange(high, high * 2) : '2-8w' },
    expectedTimeBasis: banded ? 'card liquidity bands' : 'generic estimate (no liquidity data for this card)',
  };
}

function candidateFromRow(row) {
  const cardId = String(row.card_id);
  return {
    cardId,
    blueprintId: blueprintIdFromCardId(row.card_id),
    name: row.name || '',
    setName: row.set_name || '',
    cardNumber: row.card_number || '',
    artist: row.artist || '',
    itemKind: row.item_kind || '',
    version: row.version ? String(row.version) : '',
    path: cardId ? `/marketplace/en/cards/${cardId}` : '',
    canonicalPath: cardId ? `/marketplace/en/cards/${cardId}` : '',
  };
}

/**
 * One printing per CLIP same-artwork group. Same painting reprinted across
 * half-decks/products collapses; different artworks of the same name stay.
 */
function dedupeArtworkVersions(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const version = String(row?.version || '').trim();
    const key = version || `id:${row?.card_id || row?.cardId || out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// Chatter words that must never break a card-name match. 'ex'/'gx'/'v' are
// deliberately NOT here — they are part of real card names.
const QUERY_FILLER_RE = /\b(hi|hello|hey|please|can|could|tell|me|do|does|did|you|know|i|im|i have|have|has|got|how|much|what|whats|worth|price|prices|priced|cost|costs|value|valued|values|market|sell|selling|sold|sale|buy|buying|for|about|around|roughly|approximately|near|mint|lightly|slightly|played|moderately|heavily|damaged|poor|condition|in|on|of|the|a|an|is|are|was|were|it|its|this|that|and|or|english|italian|french|german|spanish|japanese|from|with|any|some|one|copy|copies|right|now|currently|today|it is|its)\b/gi;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'from', 'old', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'was', 'it', 'its', 'this', 'that', 'my', 'your', 'have', 'has', 'how',
  'much', 'what', 'worth', 'price', 'cost', 'value', 'sell', 'sold', 'near',
  'mint', 'played', 'damaged', 'condition', 'english', 'italian', 'japanese',
]);

function queryVariants(rawQuery) {
  const text = cleanText(rawQuery, 120);
  if (!text) return [];
  const variants = [];
  const cleaned = text
    .replace(/[,.!?;:()]+/g, ' ')
    .replace(QUERY_FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length >= 4) variants.push(cleaned);
  if (text !== cleaned && text.length >= 4) variants.push(text);
  return variants.slice(0, 3);
}

async function resolveCard(params = {}) {
  const query = cleanText(params.query, 120);
  const artist = cleanText(params.artist, 80);
  if (!query && !artist) {
    return { status: 'invalid', error: 'query or artist required' };
  }
  const artistPattern = artist ? `%${escapeLike(artist)}%` : null;
  // Token-AND search: every significant word of the chat phrase must appear in
  // search_text, in any order — "rocky helmet boundaries crossed secret rare
  // 153/149" and "claydol ex ex power keepers" both resolve.
  for (const variant of queryVariants(query)) {
    const tokens = variant
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
    if (!tokens.length) continue;
    const conditions = tokens.map((_, i) => `s.search_text ilike $${i + 1}`);
    const params2 = tokens.map((t) => `%${escapeLike(t)}%`);
    if (artistPattern) {
      conditions.push(`s.artist ilike $${params2.length + 1}`);
      params2.push(artistPattern);
    }
    const rows = await queryRows(
      `select s.card_id, s.name, s.set_name, s.artist, s.item_kind, s.version,
              coalesce(nullif(c.card_number, ''), '') as card_number
         from marketplace_search_candidates s
         left join marketplace_cards c on c.card_id = s.card_id
        where s.item_kind <> 'product'
          and ${conditions.join(' and ')}
        order by s.search_weight desc nulls last, s.name
        limit 24`,
      params2,
    );
    if (rows.length) {
      const deduped = dedupeArtworkVersions(rows).slice(0, 7);
      const collapsed = rows.length - deduped.length;
      return {
        status: deduped.length === 1 ? 'ok' : 'ambiguous',
        candidates: deduped.map(candidateFromRow),
        sameArtworkCollapsed: collapsed > 0 ? collapsed : undefined,
        note: deduped.length > 1
          ? 'Multiple different artworks match; ask which one they mean. Same-artwork reprints across products were collapsed.'
          : (collapsed > 0
            ? 'Other catalog rows are the same artwork in other products/half-decks; only one printing is returned.'
            : undefined),
      };
    }
  }
  return {
    status: 'not_found',
    error: 'no catalog match',
    note: 'The assistant should ask the user to double-check the card name or set.',
  };
}

// ---------------------------------------------------------------------------
// Sold slices — the same slice key the card-page sold graph uses
// (condition, language, reverse, first_edition, graded). A Neo Discovery
// 1st Edition sale is not a comp for an Unlimited copy, and a graded slab is
// not a comp for a raw card, so every sold figure below is computed per
// variant, standard copies by default (mirrors the graph's default chips).
// ---------------------------------------------------------------------------

const SOLD_ROWS_LIMIT = 3000;
// One day-slice row carries a daily median and its unit count; cap the weight
// so one bulk lot cannot drown every other sale.
const MAX_UNITS_PER_ROW = 50;
const DEAL_MIN_COMPS = 2;

function soldFlag(value) {
  if (value === true || value === false) return value;
  const text = cleanText(value, 40).toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'y', 'si', 'sì', 'on', 'reverse', 'reverse holo', 'graded', 'slab', 'first', '1st', '1st edition', 'first edition', 'prima edizione'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'standard', 'unlimited', 'raw', 'ungraded', 'normal'].includes(text)) return false;
  return null;
}

/** Variant slice asked for; unstated flags mean "standard copy" (flag false). */
function soldFacetFromParams(params = {}) {
  const reverse = soldFlag(params.reverse);
  const firstEdition = soldFlag(params.firstEdition ?? params.first_edition ?? params.edition);
  const graded = soldFlag(params.graded);
  return {
    reverse: reverse ?? false,
    firstEdition: firstEdition ?? false,
    graded: graded ?? false,
    explicit: reverse !== null || firstEdition !== null || graded !== null,
  };
}

function facetKey(row) {
  return [Boolean(row.reverse), Boolean(row.first_edition ?? row.firstEdition), Boolean(row.graded)].join('|');
}

function facetLabel(facet) {
  const parts = [];
  if (facet.firstEdition) parts.push('1st Edition');
  if (facet.reverse) parts.push('Reverse Holo');
  if (facet.graded) parts.push('Graded');
  return parts.length ? parts.join(' + ') : 'Standard (unlimited, non-reverse, ungraded)';
}

function rowMatchesFacet(row, facet) {
  return Boolean(row.reverse) === facet.reverse
    && Boolean(row.first_edition ?? row.firstEdition) === facet.firstEdition
    && Boolean(row.graded) === facet.graded;
}

function rowMatchesSlice(row, { facet, condition, language } = {}) {
  if (facet && !rowMatchesFacet(row, facet)) return false;
  if (condition && String(row.condition) !== condition) return false;
  if (language && String(row.language || '').toUpperCase() !== language) return false;
  return true;
}

function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function percentileOf(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Unit-weighted sold stats over day-slice rows (each daily median counted once per unit sold). */
function soldStats(rows = []) {
  const prices = [];
  let soldQty = 0;
  let minPkn = Infinity;
  let maxPkn = 0;
  let lastSaleDay = null;
  const days = new Set();
  for (const row of rows) {
    const qty = Math.max(0, Math.trunc(Number(row.sold_qty) || 0));
    const median = Number(row.median_pkn);
    if (!(qty > 0) || !(median > 0)) continue;
    soldQty += qty;
    for (let i = 0; i < Math.min(qty, MAX_UNITS_PER_ROW); i += 1) prices.push(median);
    minPkn = Math.min(minPkn, Number(row.min_pkn) > 0 ? Number(row.min_pkn) : median);
    maxPkn = Math.max(maxPkn, Number(row.max_pkn) > 0 ? Number(row.max_pkn) : median);
    const day = dayOf(row.observed_day);
    if (day) {
      days.add(day);
      if (!lastSaleDay || day > lastSaleDay) lastSaleDay = day;
    }
  }
  if (!soldQty) return null;
  prices.sort((a, b) => a - b);
  return {
    soldQty,
    saleDays: days.size,
    median: round2(percentileOf(prices, 0.5)),
    p25: round2(percentileOf(prices, 0.25)),
    p75: round2(percentileOf(prices, 0.75)),
    min: round2(minPkn),
    max: round2(maxPkn),
    lastSaleDay,
  };
}

function soldEstimateFromStats(stats, basis) {
  if (!stats) return null;
  return {
    currency: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    median: stats.median,
    medianEur: round2(stats.median * PKN_EUR_RATE),
    p25: stats.p25,
    p75: stats.p75,
    low: stats.min,
    high: stats.max,
    sampleSize: stats.soldQty,
    saleDays: stats.saleDays,
    lastSaleDay: stats.lastSaleDay,
    basis,
    methodology: 'unit-weighted median of CardTrader inferred sales (cardtrader_sold_daily), same variant only',
    confidence: confidenceForSample(stats.soldQty),
  };
}

async function soldRowsForBlueprint(blueprintId, days) {
  return queryRows(
    `select observed_day, condition, language, reverse, first_edition, graded,
            sold_qty, median_pkn, min_pkn, max_pkn
       from cardtrader_sold_daily
      where blueprint_id = $1::bigint
        and observed_day >= current_date - ($2::int || ' days')::interval
        and sold_qty > 0
      order by observed_day desc
      limit ${SOLD_ROWS_LIMIT}`,
    [String(blueprintId), days],
  );
}

/**
 * Pick the variant slice. Unstated flags quote standard copies; when a printing
 * never sold a standard copy (reverse-only promos, 1st-Ed-only prints) snap to
 * its most-sold variant instead of answering "no data" — same rule as the
 * card-page graph's chip snap-back.
 */
function resolveFacet(rows, params = {}) {
  const facet = soldFacetFromParams(params);
  const matched = rows.some((row) => rowMatchesFacet(row, facet));
  if (matched || facet.explicit || !rows.length) {
    return { facet, snapped: false };
  }
  const units = new Map();
  for (const row of rows) {
    const key = facetKey(row);
    units.set(key, (units.get(key) || 0) + (Number(row.sold_qty) || 0));
  }
  const [bestKey] = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
  const [reverse, firstEdition, graded] = bestKey.split('|').map((v) => v === 'true');
  return { facet: { reverse, firstEdition, graded, explicit: false }, snapped: true };
}

function variantsSold(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = facetKey(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [reverse, firstEdition, graded] = key.split('|').map((v) => v === 'true');
    const stats = soldStats(list);
    return {
      variant: facetLabel({ reverse, firstEdition, graded }),
      reverse,
      firstEdition,
      graded,
      soldQty: stats ? stats.soldQty : 0,
      medianPkn: stats ? stats.median : null,
      lastSaleDay: stats ? stats.lastSaleDay : null,
    };
  }).sort((a, b) => b.soldQty - a.soldQty);
}

function soldByConditionLanguage(rows, limit = 10) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.condition}|${String(row.language || '').toUpperCase()}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [condition, language] = key.split('|');
    const stats = soldStats(list);
    return {
      condition,
      language,
      soldQty: stats ? stats.soldQty : 0,
      medianPkn: stats ? stats.median : null,
      lowPkn: stats ? stats.min : null,
      highPkn: stats ? stats.max : null,
      lastSaleDay: stats ? stats.lastSaleDay : null,
    };
  }).sort((a, b) => b.soldQty - a.soldQty).slice(0, limit);
}

/** Standard-variant sold summary (with snap-back) — used by liquidity fallbacks. */
async function soldSummaryForBlueprint(blueprintId, condition, language, days) {
  const rows = await soldRowsForBlueprint(blueprintId, days);
  const { facet } = resolveFacet(rows, {});
  const stats = soldStats(rows.filter((row) => rowMatchesSlice(row, { facet, condition, language })));
  return soldEstimateFromStats(stats, facetLabel(facet));
}

/**
 * Live CardTrader book for one printing, grouped by the sold slice key so asks
 * compare like-for-like with sales. Only listings from the printing's latest
 * dump are live; older last_seen_at rows are gone from the book.
 */
async function liveAsksForBlueprint(blueprintId) {
  const rows = await queryRows(
    `with book as (
       select s.condition, s.language, s.properties, s.price, s.quantity, s.last_seen_at
         from cardtrader_market_listing_snapshots s
        where coalesce(s.blueprint_id, s.cardtrader_blueprint_id) = $1::bigint
          and s.price::numeric > 0
          and s.quantity > 0
     ), live as (
       select * from book
        where last_seen_at >= (select max(last_seen_at) from book) - interval '20 hours'
     )
     select cardtrader_sold_condition(condition) as condition,
            nullif(cardtrader_sold_language(language), '') as language,
            coalesce((properties->>'pokemon_reverse')::boolean, false) as reverse,
            coalesce((properties->>'first_edition')::boolean, false) as first_edition,
            false as graded,
            count(*)::int as listings,
            sum(quantity)::int as copies,
            min(price::numeric) as min_eur,
            percentile_cont(0.5) within group (order by price::numeric) as median_eur
       from live
      group by 1, 2, 3, 4`,
    [String(blueprintId)],
  );
  return rows.map((row) => ({
    condition: row.condition,
    language: row.language ? String(row.language).toUpperCase() : null,
    reverse: Boolean(row.reverse),
    first_edition: Boolean(row.first_edition),
    graded: false,
    listings: Number(row.listings) || 0,
    copies: Number(row.copies) || 0,
    minPkn: round2(Number(row.min_eur) / PKN_EUR_RATE),
    medianPkn: round2(Number(row.median_eur) / PKN_EUR_RATE),
  }));
}

function summarizeLiveAsks(groups) {
  if (!groups.length) return null;
  let min = Infinity;
  let listings = 0;
  let copies = 0;
  const medians = [];
  for (const group of groups) {
    min = Math.min(min, group.minPkn);
    listings += group.listings;
    copies += group.copies;
    for (let i = 0; i < Math.min(group.listings, MAX_UNITS_PER_ROW); i += 1) medians.push(group.medianPkn);
  }
  medians.sort((a, b) => a - b);
  return {
    min: round2(min),
    minEur: round2(min * PKN_EUR_RATE),
    median: round2(percentileOf(medians, 0.5)),
    listings,
    copies,
    currency: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    basis: 'live CardTrader listings, same variant (and condition/language when given)',
    note: 'asking price, not a confirmed sale',
  };
}

function dealVerdict(ask, soldMedian) {
  if (!(ask > 0) || !(soldMedian > 0)) return null;
  const ratio = ask / soldMedian;
  // Far under the sold median usually means the "sales" were pricier listings
  // that were delisted, not a real bargain — say so instead of cheering.
  if (ratio < 0.35) {
    return {
      verdict: 'far_below_sold_median',
      ratio: round2(ratio),
      caution: 'Ask is far below recorded sales; those comps may be delisted high asks. Check the listing before calling it a bargain.',
    };
  }
  if (ratio <= 0.8) return { verdict: 'below_sold_median', ratio: round2(ratio) };
  if (ratio <= 1.2) return { verdict: 'in_line_with_sales', ratio: round2(ratio) };
  return { verdict: 'above_sold_median', ratio: round2(ratio) };
}

const FLUCTUATION_PCT = 15;

/** Daily min/median asks over the last `days`, with dated fluctuation moves. */
async function askHistoryForBlueprint(blueprintId, days = 14) {
  const rows = await queryRows(
    `select observed_day, min_price_pkn, median_price_pkn
       from cardtrader_blueprint_daily_analytics
      where blueprint_id = $1::bigint
        and observed_day >= current_date - ($2::int || ' days')::interval
      order by observed_day`,
    [String(blueprintId), days],
  );
  const series = rows.map((r) => ({
    day: String(r.observed_day).slice(0, 10),
    min: round2(r.min_price_pkn),
    median: round2(r.median_price_pkn),
  })).filter((p) => p.min != null);
  const fluctuations = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!prev.min || !cur.min) continue;
    const changePct = Math.round(((cur.min - prev.min) / prev.min) * 100);
    if (Math.abs(changePct) >= FLUCTUATION_PCT) {
      fluctuations.push({
        fromDay: prev.day,
        toDay: cur.day,
        from: prev.min,
        to: cur.min,
        changePct,
      });
    }
  }
  let trend = 'stable';
  if (series.length >= 2) {
    const first = series[0].min;
    const last = series[series.length - 1].min;
    if (first && last) {
      const move = ((last - first) / first) * 100;
      if (move >= 10) trend = 'rising';
      else if (move <= -10) trend = 'falling';
    }
  }
  return { days, series, fluctuations, trend };
}

async function askSignalForBlueprint(blueprintId) {
  const rows = await queryRows(
    `select min_price_pkn, median_price_pkn, observed_day
       from cardtrader_blueprint_daily_analytics
      where blueprint_id = $1::bigint
      order by observed_day desc
      limit 1`,
    [String(blueprintId)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    min: round2(row.min_price_pkn),
    median: round2(row.median_price_pkn),
    currency: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    observedDay: row.observed_day ? String(row.observed_day).slice(0, 10) : null,
    note: 'current asks, all conditions; asking price is not a confirmed sale',
  };
}

/** Resolve a params.cardId or params.query into { card, blueprintId } or an error payload. */
async function requireCard(params) {
  const cardId = cleanText(params.cardId, 40);
  if (/^\d+$/.test(cardId)) {
    const rows = await queryRows(
      `select card_id, name, set_name, artist, item_kind
         from marketplace_search_candidates
        where card_id = $1 limit 1`,
      [cardId],
    );
    if (!rows.length) return { error: { status: 'not_found', error: 'unknown cardId' } };
    return { card: candidateFromRow(rows[0]) };
  }
  const resolved = await resolveCard({ query: params.query, artist: params.artist });
  if (resolved.status !== 'ok') {
    return { error: { status: resolved.status === 'invalid' ? 400 : 422, ...resolved } };
  }
  return { card: resolved.candidates[0] };
}

/**
 * Approximate western leftover OCR for attacks / abilities / rules chrome.
 * Source rows come from scripts/import-marketplace-card-ocr.py (PP-OCRv5 jsonl).
 * Missing or junk OCR → not_found / low-confidence note; never invent text.
 */
async function cardOcr(params = {}) {
  const owned = await requireCard(params);
  if (owned.error) return owned.error;
  const card = owned.card;
  const leftoverId = blueprintIdFromCardId(card.cardId);
  const rows = await queryRows(
    `select card_id, leftover_id, name, set_name, card_number, text, junk, ok,
            engine, crop, line_count, updated_at
       from marketplace_card_ocr
      where card_id = $1
         or ($2::bigint is not null and leftover_id = $2)
      order by (card_id = $1) desc
      limit 1`,
    [String(card.cardId), leftoverId],
  );
  const row = rows[0];
  if (!row || !row.ok) {
    return {
      status: 'not_found',
      card,
      error: 'no OCR text for this printing yet (western leftovers only)',
      note: 'Say you do not have scanned card text for this printing; do not invent attacks or HP.',
    };
  }
  const text = String(row.text || '').trim().slice(0, 1500);
  if (!text) {
    return {
      status: 'not_found',
      card,
      error: 'OCR row empty',
      note: 'Say you do not have scanned card text for this printing; do not invent attacks or HP.',
    };
  }
  return {
    status: 'ok',
    card,
    ocr: {
      text,
      junk: Boolean(row.junk),
      crop: row.crop || null,
      engine: row.engine || null,
      lineCount: Number(row.line_count) || null,
      leftoverId: Number(row.leftover_id) || leftoverId,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
      methodology: 'western leftover PP-OCRv5 chrome; approximate, not official card text',
      confidence: row.junk ? 'low' : 'medium',
    },
    note: row.junk
      ? 'OCR looks noisy (energy/short chrome). Prefer catalog identity over this text.'
      : 'Use this OCR only for attacks/abilities/rules on this cardId; never swap to another printing.',
  };
}

async function cardQuote(params = {}) {
  const owned = await requireCard(params);
  if (owned.error) return owned.error;
  const card = owned.card;
  const blueprintId = blueprintIdFromCardId(card.cardId);
  if (blueprintId == null) {
    return { status: 'unsupported', error: 'card_quote needs a single card (public even card id)', card };
  }

  // Unstated condition / language mean "every copy of this variant", not NM/EN:
  // defaulting to NM English hid real sales of SP or Italian copies and made
  // Poko say "no confirmed sale" on cards that sell every week.
  const cond = normalizeCondition(params.condition);
  const lang = normalizeLanguage(params.language);
  const conditionGiven = cond.matched;
  const languageGiven = lang.matched;

  const variants = [{ condition: conditionGiven ? cond.primary : null, language: languageGiven ? lang.code : null, vague: false }];
  if (cond.vague && cond.alternatives.length) {
    variants[0].vague = true;
    variants.push({ condition: cond.alternatives[0], language: variants[0].language, vague: true });
  }

  const [rows, liveGroups, askHistory, liquidity, blueprintAsk] = await Promise.all([
    soldRowsForBlueprint(blueprintId, 90),
    liveAsksForBlueprint(blueprintId),
    askHistoryForBlueprint(blueprintId, 14),
    cardLiquidity({ cardId: card.cardId }),
    askSignalForBlueprint(blueprintId),
  ]);
  const { facet, snapped } = resolveFacet(rows, params);
  const facetRows = rows.filter((row) => rowMatchesFacet(row, facet));
  const variantLabel = facetLabel(facet);

  const quotes = variants.map((variant) => {
    const slice = { facet, condition: variant.condition, language: variant.language };
    let stats = soldStats(rows.filter((row) => rowMatchesSlice(row, slice)));
    let fallback;
    if (!stats && (variant.condition || variant.language) && facetRows.length) {
      stats = soldStats(facetRows);
      fallback = `No ${[variant.condition, variant.language].filter(Boolean).join(' ')} sale of this variant in 90 days; estimate uses every condition and language of the same variant.`;
    }
    const estimate = soldEstimateFromStats(stats, [
      variantLabel,
      fallback ? 'all conditions, all languages' : (variant.condition || 'all conditions'),
      fallback ? null : (variant.language || 'all languages'),
    ].filter(Boolean).join(' · '));
    const liveMatch = liveGroups.filter((group) => rowMatchesSlice(group, slice));
    const currentAsk = summarizeLiveAsks(liveMatch)
      || (blueprintAsk ? { ...blueprintAsk, basis: 'lowest ask across all conditions/languages/variants (no same-slice live listing)' } : null);
    // Cheapest ask vs sold median only means something inside one exact
    // condition × language slice; a Poor Italian ask against an all-condition
    // median is noise (deal_check does the per-slice comparison).
    const exactSlice = Boolean(variant.condition && variant.language && !fallback);
    return {
      condition: variant.condition || 'all',
      language: variant.language || 'all',
      vagueWording: variant.vague || undefined,
      estimate,
      estimateFallback: fallback,
      currentAsk,
      askVsSold: exactSlice && currentAsk && estimate ? dealVerdict(currentAsk.min, estimate.median) : null,
      liquidity: liquidity.liquidity || undefined,
      strategies: priceStrategies(estimate, exactSlice ? currentAsk : null, liquidity.liquidity),
      askingPriceOnly: !estimate,
    };
  });

  return {
    status: 'ok',
    today: todayIso(),
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    card,
    filters: {
      condition: conditionGiven ? cond.primary : 'all',
      language: languageGiven ? lang.code : 'all',
      conditionVague: cond.vague,
      variant: variantLabel,
    },
    variantNote: snapped
      ? `This printing never sold a standard copy in 90 days; quoting its most-sold variant (${variantLabel}).`
      : undefined,
    window: { soldDays: 90, from: daysAgoIso(90), to: daysAgoIso(0) },
    askHistory,
    conditionNote: cond.vague
      ? `Vague condition wording: showing ${cond.primary} and ${cond.alternatives[0]} ranges instead of claiming a grade.`
      : undefined,
    quotes,
    variantsSold: variantsSold(rows),
    soldByConditionLanguage: soldByConditionLanguage(facetRows, 8),
    dataNote: 'Sold = CardTrader listings that left the book (inferred sales, sanitized). 1st Edition, reverse and graded sales are separate variants and never mixed into the standard price.',
  };
}

/**
 * Sold history for one printing: dated day-slices ("how many sold?", "last
 * sale?", "vendite recenti") plus 7/30/90-day totals for the variant.
 */
async function cardSales(params = {}) {
  const owned = await requireCard(params);
  if (owned.error) return owned.error;
  const card = owned.card;
  const blueprintId = blueprintIdFromCardId(card.cardId);
  if (blueprintId == null) {
    return { status: 'unsupported', error: 'card_sales needs a single card (public even card id)', card };
  }
  const days = Math.min(Math.max(Number(params.days) || 30, 1), 90);
  const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 60);
  const cond = normalizeCondition(params.condition);
  const lang = normalizeLanguage(params.language);
  const condition = cond.matched && !cond.vague ? cond.primary : null;
  const language = lang.matched ? lang.code : null;

  const rows = await soldRowsForBlueprint(blueprintId, 90);
  const { facet, snapped } = resolveFacet(rows, params);
  const slice = { facet, condition, language };
  const sliceRows = rows.filter((row) => rowMatchesSlice(row, slice));
  const windowStart = daysAgoIso(days);
  const inWindow = sliceRows.filter((row) => dayOf(row.observed_day) >= windowStart);
  const since = (n) => {
    const from = daysAgoIso(n);
    const stats = soldStats(sliceRows.filter((row) => dayOf(row.observed_day) >= from));
    return stats
      ? { units: stats.soldQty, saleDays: stats.saleDays, medianPkn: stats.median, lowPkn: stats.min, highPkn: stats.max }
      : { units: 0, saleDays: 0, medianPkn: null };
  };

  const sales = inWindow
    .slice()
    .sort((a, b) => String(dayOf(b.observed_day)).localeCompare(String(dayOf(a.observed_day))))
    .slice(0, limit)
    .map((row) => ({
      day: dayOf(row.observed_day),
      condition: row.condition,
      language: String(row.language || '').toUpperCase(),
      units: Number(row.sold_qty) || 0,
      medianPkn: round2(row.median_pkn),
      lowPkn: round2(row.min_pkn),
      highPkn: round2(row.max_pkn),
    }));

  return {
    status: 'ok',
    today: todayIso(),
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    card,
    filters: { variant: facetLabel(facet), condition: condition || 'all', language: language || 'all' },
    variantNote: snapped ? `No standard-copy sales; showing the most-sold variant (${facetLabel(facet)}).` : undefined,
    window: { days, from: windowStart, to: daysAgoIso(0) },
    totals: { last7d: since(7), last30d: since(30), last90d: since(90) },
    lastSale: sales[0] || null,
    sales,
    otherVariants: variantsSold(rows).filter((v) => v.variant !== facetLabel(facet)),
    note: sales.length
      ? 'Each row is one day × condition × language: units that left the CardTrader book and their median price that day.'
      : `No sale of this variant in the last ${days} days.`,
  };
}

/**
 * "Should I buy it / is it a good deal?" — cheapest live listings per
 * condition × language, each compared with sold comps of the exact same
 * slice (variant + condition + language). No cross-slice comps.
 */
async function dealCheck(params = {}) {
  const owned = await requireCard(params);
  if (owned.error) return owned.error;
  const card = owned.card;
  const blueprintId = blueprintIdFromCardId(card.cardId);
  if (blueprintId == null) {
    return { status: 'unsupported', error: 'deal_check needs a single card (public even card id)', card };
  }
  const cond = normalizeCondition(params.condition);
  const lang = normalizeLanguage(params.language);
  const condition = cond.matched && !cond.vague ? cond.primary : null;
  const language = lang.matched ? lang.code : null;

  const [rows, liveGroups] = await Promise.all([
    soldRowsForBlueprint(blueprintId, 90),
    liveAsksForBlueprint(blueprintId),
  ]);
  const facet = soldFacetFromParams(params);
  const offers = liveGroups
    .filter((group) => rowMatchesSlice(group, {
      facet: facet.explicit ? facet : null,
      condition,
      language,
    }))
    .map((group) => {
      const groupFacet = { reverse: group.reverse, firstEdition: group.first_edition, graded: false };
      const comps = soldStats(rows.filter((row) => rowMatchesSlice(row, {
        facet: groupFacet,
        condition: group.condition,
        language: group.language,
      })));
      const hasComps = comps && comps.soldQty >= DEAL_MIN_COMPS;
      return {
        variant: facetLabel(groupFacet),
        condition: group.condition,
        language: group.language || 'print language',
        cheapestAskPkn: group.minPkn,
        cheapestAskEur: round2(group.minPkn * PKN_EUR_RATE),
        listings: group.listings,
        soldMedianPkn: hasComps ? comps.median : null,
        soldUnits90d: comps ? comps.soldQty : 0,
        lastSaleDay: comps ? comps.lastSaleDay : null,
        ...(hasComps ? dealVerdict(group.minPkn, comps.median) : { verdict: 'no_same_slice_sales', ratio: null }),
      };
    })
    .sort((a, b) => a.cheapestAskPkn - b.cheapestAskPkn);

  // far_below comps are usually pulled high asks, so never headline them.
  const compared = offers.filter((offer) => offer.ratio != null && offer.verdict !== 'far_below_sold_median');
  const bestValue = compared.slice().sort((a, b) => a.ratio - b.ratio)[0] || null;
  return {
    status: 'ok',
    today: todayIso(),
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    card,
    filters: {
      variant: facet.explicit ? facetLabel(facet) : 'all live variants',
      condition: condition || 'all',
      language: language || 'all',
    },
    bestValue,
    offers: offers.slice(0, 10),
    liveListingGroups: offers.length,
    note: offers.length
      ? 'ratio = cheapest ask ÷ 90-day sold median of the exact same variant/condition/language. below_sold_median ≤ 0.8, in_line ≤ 1.2. Market data, not financial advice.'
      : 'No live CardTrader listing for this printing with these filters.',
  };
}

async function cardLiquidity(params = {}) {
  const owned = await requireCard(params);
  if (owned.error) return owned.error;
  const card = owned.card;
  const rows = await queryRows(
    `select sold_qty_7d, listed_now, sell_through, days_of_supply, demand_score, updated_at
       from marketplace_card_weights
      where card_id = $1
      limit 1`,
    [card.cardId],
  );
  const weights = rows[0] || null;
  let bands = null;
  let source = 'weights';
  if (weights && weightsAreFresh(weights.updated_at)) {
    bands = liquidityBands({
      daysOfSupply: weights.days_of_supply,
      soldQty7d: weights.sold_qty_7d,
      listedNow: weights.listed_now,
    });
  }
  if (!bands) {
    const blueprintId = blueprintIdFromCardId(card.cardId);
    if (blueprintId != null) {
      const sold = await soldSummaryForBlueprint(blueprintId, null, null, 28);
      if (sold && sold.sampleSize > 0) {
        bands = liquidityBands({ daysOfSupply: null, soldQty7d: sold.sampleSize / 4, listedNow: 1 });
        source = 'sold_daily_fallback';
      }
    }
  }
  return {
    status: 'ok',
    card,
    liquidity: bands
      ? { ...bands, source }
      : { typicalDays: null, methodology: 'insufficient market activity', confidence: 'none', source: 'none' },
    weights: weights
      ? {
          soldQty7d: Number(weights.sold_qty_7d) || 0,
          listedNow: Number(weights.listed_now) || 0,
          sellThrough: round2(weights.sell_through),
          daysOfSupply: round2(weights.days_of_supply),
        }
      : null,
  };
}

async function collectionQuote(params = {}) {
  const artistInput = cleanText(params.artist, 80);
  if (!artistInput) return { status: 'invalid', error: 'artist required' };
  const cond = normalizeCondition(params.condition || 'NM');
  const lang = normalizeLanguage(params.language || 'EN');

  // Fuzzy artist resolution: exact first, then subsequence pattern; never silently
  // pick when several artists fit.
  const artistRows = await queryRows(
    `select artist, count(*)::int as cards
       from marketplace_search_candidates
      where item_kind <> 'product' and artist <> ''
        and (artist = $1 or artist ilike $2)
      group by artist
      order by (artist = $1) desc, cards desc
      limit 5`,
    [artistInput, fuzzyArtistPattern(artistInput)],
  );
  if (!artistRows.length) return { status: 'not_found', error: 'no artist matches that name' };
  if (artistRows.length > 1 && !artistRows.some((r) => r.artist.toLowerCase() === artistInput.toLowerCase())) {
    return {
      status: 'ambiguous',
      artists: artistRows.map((r) => ({ artist: r.artist, cards: r.cards })),
      note: 'Ask one concise clarification question; do not silently resolve.',
    };
  }
  const artist = artistRows[0].artist;

  const cardRows = await queryRows(
    `select s.card_id, s.name, s.set_name, s.artist, s.item_kind,
            coalesce(nullif(c.card_number, ''), '') as card_number
       from marketplace_search_candidates s
       left join marketplace_cards c on c.card_id = s.card_id
      where s.item_kind <> 'product' and s.artist = $1
      order by s.name
      limit $2`,
    [artist, MAX_COLLECTION_CARDS],
  );
  const cards = cardRows.map(candidateFromRow);
  const blueprintIds = cards
    .map((c) => blueprintIdFromCardId(c.cardId))
    .filter((id) => id != null);

  if (!cards.length) return { status: 'not_found', error: 'no catalog cards for that artist' };

  const soldRows = blueprintIds.length
    ? await queryRows(
        `select blueprint_id,
                sum(sold_qty)::int as sold_qty,
                percentile_cont(0.5) within group (order by median_pkn) as median_daily
           from cardtrader_sold_daily
          where blueprint_id = any($1::bigint[])
            and observed_day >= current_date - interval '90 days'
            and ($2::text is null or condition = $2)
            and ($3::text is null or language = $3)
            and sold_qty > 0
          group by blueprint_id`,
        [blueprintIds.map(String), cond.primary, lang.code],
      )
    : [];
  const askRows = blueprintIds.length
    ? await queryRows(
        `select distinct on (blueprint_id) blueprint_id, min_price_pkn, observed_day
           from cardtrader_blueprint_daily_analytics
          where blueprint_id = any($1::bigint[])
          order by blueprint_id, observed_day desc`,
        [blueprintIds.map(String)],
      )
    : [];
  const soldByBlueprint = new Map(soldRows.map((r) => [String(r.blueprint_id), r]));
  const askByBlueprint = new Map(askRows.map((r) => [String(r.blueprint_id), r]));

  let priced = 0;
  let marketTotal = 0;
  let acquireTotal = 0;
  const pricedCards = [];
  for (const card of cards) {
    const bp = card.blueprintId != null ? String(card.blueprintId) : null;
    const sold = bp ? soldByBlueprint.get(bp) : null;
    const ask = bp ? askByBlueprint.get(bp) : null;
    const soldMedian = sold && sold.sold_qty > 0 ? round2(sold.median_daily) : null;
    const minAsk = ask && ask.min_price_pkn != null ? round2(ask.min_price_pkn) : null;
    if (soldMedian == null && minAsk == null) continue;
    priced += 1;
    const marketValue = soldMedian ?? minAsk;
    const acquisition = minAsk ?? soldMedian;
    marketTotal += marketValue;
    acquireTotal += acquisition;
    pricedCards.push({
      cardId: card.cardId,
      name: card.name,
      setName: card.setName,
      cardNumber: card.cardNumber,
      value: marketValue,
      basis: soldMedian != null ? 'sold_median_90d' : 'lowest_current_ask',
      soldQty90d: sold ? sold.sold_qty : 0,
    });
  }
  pricedCards.sort((a, b) => b.value - a.value);

  return {
    status: 'ok',
    artist,
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    filters: { condition: cond.primary, language: lang.code, quantityPerCard: 1 },
    cardsTotal: cards.length,
    cardsPriced: priced,
    cardsUnpriced: cards.length - priced,
    coveragePct: cards.length ? Math.round((priced / cards.length) * 100) : 0,
    estimatedMarketValue: round2(marketTotal),
    estimatedAcquisitionCost: round2(acquireTotal),
    note: 'estimated market value (sold medians) and cost to acquire today (lowest asks) are different metrics; when few copies exist, acquisition cost is the realistic one.',
    mostExpensive: pricedCards.slice(0, 5),
    lowestLiquidity: pricedCards
      .slice()
      .sort((a, b) => a.soldQty90d - b.soldQty90d)
      .slice(0, 5),
    truncated: cards.length >= MAX_COLLECTION_CARDS || undefined,
  };
}

async function suggestCards(params = {}) {
  const subject = cleanText(params.subject, 80);
  const excludeCardId = cleanText(params.excludeCardId, 40);
  const limit = Math.min(Math.max(Number(params.limit) || 6, 1), 12);
  if (!subject) return { status: 'invalid', error: 'subject required' };
  const tokens = subject.toLowerCase().split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens.length) return { status: 'invalid', error: 'subject required' };
  const conditions = tokens.map((_, i) => `s.search_text ilike $${i + 1}`);
  const values = tokens.map((t) => `%${escapeLike(t)}%`);
  const rows = await queryRows(
    `select s.card_id, s.name, s.set_name, s.artist, s.item_kind, s.version,
            coalesce(nullif(c.card_number, ''), '') as card_number,
            ask.min_price_pkn
       from marketplace_search_candidates s
       left join marketplace_cards c on c.card_id = s.card_id
       left join cardtrader_blueprint_daily_analytics ask
         on ask.blueprint_id = case when s.card_id::text ~ '^[0-9]+$' then (s.card_id::text::bigint / 2) end
        and ask.observed_day = (select max(observed_day) from cardtrader_blueprint_daily_analytics)
      where s.item_kind <> 'product'
        and ${conditions.join(' and ')}
        and ($${values.length + 1}::text is null or s.card_id::text <> $${values.length + 1}::text)
      order by s.search_weight desc nulls last, s.name
      limit ${Math.max(limit * 4, 24)}`,
    [...values, excludeCardId || null],
  );
  const candidates = dedupeArtworkVersions(
    rows.filter((r) => String(r.card_id) !== excludeCardId),
  )
    .slice(0, limit)
    .map((r) => ({
      ...candidateFromRow(r),
      minAsk: r.min_price_pkn != null ? round2(r.min_price_pkn) : null,
      pricePkn: r.min_price_pkn != null ? round2(r.min_price_pkn) : null,
    }));
  if (!candidates.length) return { status: 'not_found', error: 'no catalog cards match that subject' };
  return {
    status: 'ok',
    subject,
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    cards: candidates,
    note: 'Real Pokoin catalog cards with current lowest ask in PKN. Same-artwork reprints are collapsed; different artworks of the same name may appear. Convert to other currencies only when the user asks.',
  };
}

async function marketSnapshot(params = {}) {
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
  const rows = await queryRows(
    `select w.card_id, w.sold_qty_7d, w.listed_now, w.sell_through,
            w.median_sold_eur, w.sold_value_eur_7d,
            s.name, s.set_name, s.artist
       from marketplace_card_weights w
       left join marketplace_search_candidates s on s.card_id = w.card_id
      where w.sold_qty_7d > 0
      order by w.sold_qty_7d desc
      limit $1`,
    [limit],
  );
  return {
    status: 'ok',
    window: '7d',
    cards: rows.map((row) => ({
      cardId: String(row.card_id),
      name: row.name || '',
      setName: row.set_name || '',
      artist: row.artist || '',
      soldQty7d: Number(row.sold_qty_7d) || 0,
      listedNow: Number(row.listed_now) || 0,
      sellThrough: round2(row.sell_through),
      medianSoldEur: round2(row.median_sold_eur),
      soldValueEur7d: round2(row.sold_value_eur_7d),
    })),
  };
}

// Marketplace analytics are stored in PKN, where 1 PKN = €0.005. Exclude
// cards below €2 (400 PKN): a €0.10 → €0.40 common is "+300%" but never
// what "grew the most" means.
const PKN_EUR_RATE = 0.005;
const MOVERS_MIN_PRICE_PKN = 400;
const MOVERS_MAX_CANDIDATES = 300;

/**
 * Biggest ask-price moves for a subject ("which Raikou card rose the most?").
 * Compares each matching single's first vs latest daily median ask (min ask
 * when the median is missing) inside the window, then ranks by % change.
 * Without a subject it ranks the most-searched catalog cards.
 */
async function topMovers(params = {}) {
  const subject = cleanText(params.subject || params.query, 80);
  const days = Math.min(Math.max(Number(params.days) || 30, 7), 90);
  const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 10);
  const direction = /^(down|fall|falling|drop|losers?)$/i.test(cleanText(params.direction, 12)) ? 'down' : 'up';
  const tokens = subject
    .toLowerCase()
    .replace(/[,.!?;:()]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (subject && !tokens.length) return { status: 'invalid', error: 'subject has no searchable words' };

  const conditions = tokens.map((_, i) => `s.search_text ilike $${i + 3}`);
  const values = [days, MOVERS_MIN_PRICE_PKN, ...tokens.map((t) => `%${escapeLike(t)}%`)];
  const rows = await queryRows(
    `with cands as (
       select s.card_id, s.name, s.set_name, s.artist, s.item_kind,
              coalesce(nullif(c.card_number, ''), '') as card_number,
              (case when s.card_id::text ~ '^[0-9]+$' then s.card_id::text::bigint end) / 2 as blueprint_id
         from marketplace_search_candidates s
         left join marketplace_cards c on c.card_id = s.card_id
        where s.item_kind <> 'product'
          and (case when s.card_id::text ~ '^[0-9]+$' then s.card_id::text::bigint end) % 2 = 0
          ${conditions.length ? `and ${conditions.join(' and ')}` : ''}
        order by s.search_weight desc nulls last, s.name
        limit ${MOVERS_MAX_CANDIDATES}
     ), series as (
       select a.blueprint_id, a.observed_day,
              coalesce(a.median_price_pkn, a.min_price_pkn) as px
         from cardtrader_blueprint_daily_analytics a
         join cands on cands.blueprint_id = a.blueprint_id
        where a.observed_day >= current_date - ($1::int || ' days')::interval
          and coalesce(a.median_price_pkn, a.min_price_pkn) > 0
     ), ends as (
       select blueprint_id,
              (array_agg(px order by observed_day asc))[1] as start_px,
              min(observed_day) as start_day,
              (array_agg(px order by observed_day desc))[1] as end_px,
              max(observed_day) as end_day,
              count(*)::int as points
         from series
        group by blueprint_id
     )
     select cands.card_id, cands.name, cands.set_name, cands.artist, cands.item_kind,
            cands.card_number, ends.start_px, ends.start_day, ends.end_px, ends.end_day, ends.points
       from ends
       join cands on cands.blueprint_id = ends.blueprint_id
      where ends.points >= 2
        and ends.end_day > ends.start_day
        and greatest(ends.start_px, ends.end_px) >= $2`,
    values,
  );

  const movers = rows
    .map((row) => {
      const start = Number(row.start_px);
      const end = Number(row.end_px);
      if (!(start > 0) || !Number.isFinite(end)) return null;
      return {
        ...candidateFromRow(row),
        fromDay: row.start_day ? String(row.start_day).slice(0, 10) : null,
        toDay: row.end_day ? String(row.end_day).slice(0, 10) : null,
        fromAsk: round2(start),
        toAsk: round2(end),
        fromAskEur: round2(start * PKN_EUR_RATE),
        toAskEur: round2(end * PKN_EUR_RATE),
        changePct: Math.round(((end - start) / start) * 1000) / 10,
        observations: Number(row.points) || 0,
      };
    })
    .filter(Boolean)
    .filter((m) => Math.max(m.fromAsk, m.toAsk) >= MOVERS_MIN_PRICE_PKN)
    .filter((m) => (direction === 'up' ? m.changePct > 0 : m.changePct < 0))
    .sort((a, b) => (direction === 'up' ? b.changePct - a.changePct : a.changePct - b.changePct))
    .slice(0, limit);

  const base = {
    subject: subject || undefined,
    direction,
    window: { days, from: daysAgoIso(days), to: daysAgoIso(0) },
    basis: 'daily median asking price (min ask when median missing), all conditions; asks are not confirmed sales',
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    minPricePkn: MOVERS_MIN_PRICE_PKN,
    minPriceEur: round2(MOVERS_MIN_PRICE_PKN * PKN_EUR_RATE),
    pricedCards: rows.length,
  };
  if (!movers.length) {
    // Always 200: "nothing moved" is an answer, not a lookup failure.
    return {
      status: 'ok',
      ...base,
      movers: [],
      note: rows.length
        ? `No ${subject || 'catalog'} card moved ${direction} in the last ${days} days.`
        : `No ${subject || 'catalog'} cards above the price floor have ask history in the last ${days} days.`,
    };
  }
  return { status: 'ok', ...base, movers };
}

// Rarity labels live in the catalog card_number prefix ("Special Illustration
// Rare | 233/193"). JP "Special Art Rare" / "Art Rare" are catalogued under the
// same SIR / IR labels.
const RARITY_ALIASES = [
  [/^(sir|sar|special (illustration|art) rare)s?$/i, 'Special Illustration Rare'],
  [/^(ir|ar|illustration rare|art rare)s?$/i, 'Illustration Rare'],
  [/^(ur|ultra rare)s?$/i, 'Ultra Rare'],
  [/^(hr|hyper rare)s?$/i, 'Hyper Rare'],
  [/^(sr|secret rare)s?$/i, 'Secret Rare'],
];
// A sold median more than 20× the recent ask is a bulk lot or a placeholder
// price (one JP Arctibax "sold" 15× at 2,000,328 PKN against a 218 PKN ask).
const TOP_SELLERS_MAX_SOLD_TO_ASK = 20;
// Placeholder listings (€2,000 / €5,000 / €10,000 + fee) that a seller pulls
// get recorded as sales: a JP Magikarp that asks 822 PKN "sold" twice at
// 2,000,328 PKN. Reference = 180-day median of the daily *lowest* ask (the
// placeholder itself inflates the median ask). With no ask history at all,
// a sale above €1,000 is unverified and kept out of rankings.
// Above €500 the same fee-suffixed placeholders sit only 3–5× over the ask
// (a JP Umbreon VMAX SIR "sold" at 1,000,128 PKN against ~240,000), so
// high-value sales get a tight 3× bound; cheap cards keep the loose one.
const SOLD_REFERENCE_ASK_DAYS = 180;
const SOLD_UNVERIFIED_MAX_PKN = 200000;
const SOLD_HIGH_VALUE_PKN = 100000;
const SOLD_HIGH_VALUE_MAX_TO_ASK = 3;

function plausibleSold(soldExpr, ratioParam) {
  return `((${soldExpr} <= asks.ask_pkn * ${ratioParam}`
    + ` and (${soldExpr} < ${SOLD_HIGH_VALUE_PKN} or ${soldExpr} <= asks.ask_pkn * ${SOLD_HIGH_VALUE_MAX_TO_ASK}))`
    + ` or (asks.ask_pkn is null and ${soldExpr} < ${SOLD_UNVERIFIED_MAX_PKN}))`;
}

function normalizeRarity(value) {
  const text = cleanText(value, 60);
  if (!text) return '';
  for (const [re, label] of RARITY_ALIASES) {
    if (re.test(text)) return label;
  }
  return text;
}

/**
 * Most-sold singles over a window ("most liquid Japanese cards over €10",
 * "top 10 most sold JP Special Illustration Rares"). Ranks confirmed
 * CardTrader sales, not asks, with optional language / rarity / price /
 * subject filters. Graded slabs are excluded.
 */
async function topSellers(params = {}) {
  const days = Math.min(Math.max(Number(params.days) || 7, 1), 30);
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 20);
  const language = cleanText(params.language, 40) ? normalizeLanguage(params.language).code : null;
  const rarity = normalizeRarity(params.rarity);
  const minEur = Number(params.minPriceEur);
  const maxEur = Number(params.maxPriceEur);
  const minPricePkn = Number(params.minPricePkn) > 0 ? Number(params.minPricePkn)
    : minEur > 0 ? minEur / PKN_EUR_RATE : 0;
  const maxPricePkn = Number(params.maxPricePkn) > 0 ? Number(params.maxPricePkn)
    : maxEur > 0 ? maxEur / PKN_EUR_RATE : null;
  const subject = cleanText(params.subject || params.query, 80);
  const tokens = subject
    .toLowerCase()
    .replace(/[,.!?;:()]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  const values = [days, language, minPricePkn, maxPricePkn, limit, rarity || null, TOP_SELLERS_MAX_SOLD_TO_ASK];
  const subjectConditions = tokens.map((t) => {
    values.push(`%${escapeLike(t)}%`);
    return `s.search_text ilike $${values.length}`;
  });
  const rows = await queryRows(
    `with sold as (
       select blueprint_id,
              sum(sold_qty)::int as sold_qty,
              count(distinct observed_day)::int as sale_days,
              percentile_cont(0.5) within group (order by median_pkn) as median_pkn,
              max(observed_day) as last_sale_day
         from cardtrader_sold_daily
        where observed_day >= current_date - ($1::int || ' days')::interval
          and sold_qty > 0
          and not graded
          and ($2::text is null or language = $2)
        group by blueprint_id
     ), asks as (
       select blueprint_id,
              percentile_cont(0.5) within group (order by coalesce(min_price_pkn, median_price_pkn)) as ask_pkn
         from cardtrader_blueprint_daily_analytics
        where observed_day >= current_date - interval '${SOLD_REFERENCE_ASK_DAYS} days'
          and coalesce(min_price_pkn, median_price_pkn) > 0
          and blueprint_id in (select blueprint_id from sold)
        group by blueprint_id
     )
     select s.card_id, s.name, s.set_name, s.artist, s.item_kind, s.card_number,
            sold.sold_qty, sold.sale_days, sold.median_pkn, sold.last_sale_day, asks.ask_pkn
       from sold
       join marketplace_search_candidates s
         on s.card_id = sold.blueprint_id * 2 and s.item_kind = 'single'
       left join asks on asks.blueprint_id = sold.blueprint_id
      where sold.median_pkn >= $3
        and ($4::numeric is null or sold.median_pkn <= $4)
        and ${plausibleSold('sold.median_pkn', '$7')}
        and ($6::text is null
             or lower(split_part(s.card_number, ' | ', 1)) = lower($6)
             or lower(s.rarity) = lower($6))
        ${subjectConditions.length ? `and ${subjectConditions.join(' and ')}` : ''}
      order by sold.sold_qty desc, sold.sale_days desc
      limit $5`,
    values,
  );

  const cards = rows.map((row) => ({
    ...candidateFromRow(row),
    soldQty: Number(row.sold_qty) || 0,
    saleDays: Number(row.sale_days) || 0,
    medianSoldPkn: round2(row.median_pkn),
    medianSoldEur: round2(Number(row.median_pkn) * PKN_EUR_RATE),
    currentAskPkn: round2(row.ask_pkn),
    lastSaleDay: row.last_sale_day ? String(row.last_sale_day).slice(0, 10) : null,
  }));

  const filters = {
    language: language || 'all',
    rarity: rarity || undefined,
    subject: subject || undefined,
    minPricePkn: minPricePkn || undefined,
    maxPricePkn: maxPricePkn || undefined,
  };
  const base = {
    window: { days, from: daysAgoIso(days), to: daysAgoIso(0) },
    basis: 'confirmed CardTrader sales (ungraded), ranked by units sold; saleDays = days with at least one sale',
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    filters,
  };
  if (!cards.length) {
    return {
      status: 'ok',
      ...base,
      cards: [],
      note: `No ungraded single matching these filters sold in the last ${days} days.`,
    };
  }
  return { status: 'ok', ...base, cards };
}

function setTokens(value) {
  return cleanText(value, 80)
    .toLowerCase()
    .replace(/[,.!?;:()]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^(set|expansion|espansione|sales|vendite|sold|venduto|venduti)$/.test(t));
}

/**
 * Sales for one expansion ("how is Neo Discovery selling?", "carte più
 * vendute di 151"): unit and value totals plus top cards by units and by
 * value. Ungraded only; outlier lots above 20× the recent ask are dropped.
 */
async function setSales(params = {}) {
  const tokens = setTokens(params.setName || params.set || params.query || params.subject);
  if (!tokens.length) return { status: 'invalid', error: 'setName required' };
  const days = Math.min(Math.max(Number(params.days) || 30, 1), 90);
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 20);
  const language = cleanText(params.language, 40) ? normalizeLanguage(params.language).code : null;

  const values = [days, language, TOP_SELLERS_MAX_SOLD_TO_ASK];
  const setConditions = tokens.map((t) => {
    values.push(`%${escapeLike(t)}%`);
    return `c.set_name ilike $${values.length}`;
  });
  const rows = await queryRows(
    `with cards as (
       select c.card_id, c.name, c.set_name, c.artist, c.item_kind, c.card_number
         from marketplace_search_candidates c
        where c.item_kind = 'single'
          and ${setConditions.join(' and ')}
        limit 4000
     ), set_sold as (
       select d.blueprint_id,
              sum(d.sold_qty)::int as sold_qty,
              sum(d.sold_qty * d.median_pkn) as value_pkn,
              percentile_cont(0.5) within group (order by d.median_pkn) as median_pkn,
              max(d.observed_day) as last_sale_day
         from cardtrader_sold_daily d
        where d.blueprint_id in (select card_id / 2 from cards where card_id % 2 = 0)
          and d.observed_day >= current_date - ($1::int || ' days')::interval
          and d.sold_qty > 0
          and not d.graded
          and ($2::text is null or d.language = $2)
        group by d.blueprint_id
     ), asks as (
       select a.blueprint_id,
              percentile_cont(0.5) within group (order by coalesce(a.min_price_pkn, a.median_price_pkn)) as ask_pkn
         from cardtrader_blueprint_daily_analytics a
        where a.observed_day >= current_date - interval '${SOLD_REFERENCE_ASK_DAYS} days'
          and coalesce(a.min_price_pkn, a.median_price_pkn) > 0
          and a.blueprint_id in (select blueprint_id from set_sold)
        group by a.blueprint_id
     )
     select cards.card_id, cards.name, cards.set_name, cards.artist, cards.item_kind, cards.card_number,
            set_sold.sold_qty, set_sold.value_pkn, set_sold.median_pkn, set_sold.last_sale_day
       from set_sold
       join cards on cards.card_id = set_sold.blueprint_id * 2
       left join asks on asks.blueprint_id = set_sold.blueprint_id
      where ${plausibleSold('set_sold.median_pkn', '$3')}`,
    values,
  );

  const cards = rows.map((row) => ({
    ...candidateFromRow(row),
    soldQty: Number(row.sold_qty) || 0,
    medianSoldPkn: round2(row.median_pkn),
    soldValuePkn: round2(row.value_pkn),
    lastSaleDay: dayOf(row.last_sale_day),
  }));
  const sets = [...new Set(cards.map((c) => c.setName).filter(Boolean))];
  const totalUnits = cards.reduce((sum, c) => sum + c.soldQty, 0);
  const totalValue = cards.reduce((sum, c) => sum + (c.soldValuePkn || 0), 0);
  return {
    status: 'ok',
    today: todayIso(),
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    window: { days, from: daysAgoIso(days), to: daysAgoIso(0) },
    filters: { set: tokens.join(' '), language: language || 'all' },
    matchedSets: sets.slice(0, 8),
    totals: {
      unitsSold: totalUnits,
      soldValuePkn: round2(totalValue),
      soldValueEur: round2(totalValue * PKN_EUR_RATE),
      distinctCardsSold: cards.length,
    },
    topByUnits: cards.slice().sort((a, b) => b.soldQty - a.soldQty).slice(0, limit),
    topByValue: cards.slice().sort((a, b) => (b.medianSoldPkn || 0) - (a.medianSoldPkn || 0)).slice(0, limit),
    note: cards.length
      ? (sets.length > 1 ? 'Several expansions matched; ask which one if the user meant a single set.' : undefined)
      : `No ungraded sale in a set matching "${tokens.join(' ')}" in the last ${days} days.`,
    basis: 'CardTrader inferred sales (cardtrader_sold_daily), ungraded, all variants; value = units × daily median',
  };
}

const RECENT_SALE_VERIFY_RATIO = 3;

/**
 * Latest or most expensive recent sales market-wide ("biggest sales this
 * week", "what sold today over €50", "ultime vendite di Charizard").
 */
async function recentSales(params = {}) {
  const days = Math.min(Math.max(Number(params.days) || 3, 1), 30);
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 25);
  const sort = /^(recent|latest|date|ultime|recenti)$/i.test(cleanText(params.sort, 20)) ? 'recent' : 'price';
  const language = cleanText(params.language, 40) ? normalizeLanguage(params.language).code : null;
  const graded = soldFlag(params.graded) === true;
  const minEur = Number(params.minPriceEur);
  const minPricePkn = Number(params.minPricePkn) > 0 ? Number(params.minPricePkn)
    : minEur > 0 ? minEur / PKN_EUR_RATE : 0;
  const tokens = cleanText(params.subject || params.query, 80)
    .toLowerCase()
    .replace(/[,.!?;:()]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  const values = [days, language, graded, minPricePkn, TOP_SELLERS_MAX_SOLD_TO_ASK, limit];
  const subjectConditions = tokens.map((t) => {
    values.push(`%${escapeLike(t)}%`);
    return `s.search_text ilike $${values.length}`;
  });
  const rows = await queryRows(
    `with recent as (
       select d.blueprint_id, d.observed_day, d.condition, d.language, d.reverse, d.first_edition, d.graded,
              d.sold_qty, d.median_pkn, d.max_pkn
         from cardtrader_sold_daily d
        where d.observed_day >= current_date - ($1::int || ' days')::interval
          and d.sold_qty > 0
          and d.graded = $3
          and ($2::text is null or d.language = $2)
          and d.median_pkn >= $4
     ), asks as (
       select a.blueprint_id,
              percentile_cont(0.5) within group (order by coalesce(a.min_price_pkn, a.median_price_pkn)) as ask_pkn
         from cardtrader_blueprint_daily_analytics a
        where a.observed_day >= current_date - interval '${SOLD_REFERENCE_ASK_DAYS} days'
          and coalesce(a.min_price_pkn, a.median_price_pkn) > 0
          and a.blueprint_id in (select blueprint_id from recent)
        group by a.blueprint_id
     )
     select s.card_id, s.name, s.set_name, s.artist, s.item_kind, s.card_number,
            recent.observed_day, recent.condition, recent.language, recent.reverse, recent.first_edition,
            recent.graded, recent.sold_qty, recent.median_pkn, asks.ask_pkn
       from recent
       join marketplace_search_candidates s
         on s.card_id = recent.blueprint_id * 2 and s.item_kind = 'single'
       left join asks on asks.blueprint_id = recent.blueprint_id
      where ${plausibleSold('recent.median_pkn', '$5')}
        ${subjectConditions.length ? `and ${subjectConditions.join(' and ')}` : ''}
      order by ${sort === 'recent' ? 'recent.observed_day desc, recent.median_pkn desc' : 'recent.median_pkn desc, recent.observed_day desc'}
      limit $6`,
    values,
  );
  const sales = rows.map((row) => ({
    ...candidateFromRow(row),
    day: dayOf(row.observed_day),
    condition: row.condition,
    language: String(row.language || '').toUpperCase(),
    variant: facetLabel({ reverse: Boolean(row.reverse), firstEdition: Boolean(row.first_edition), graded: Boolean(row.graded) }),
    units: Number(row.sold_qty) || 0,
    pricePkn: round2(row.median_pkn),
    priceEur: round2(Number(row.median_pkn) * PKN_EUR_RATE),
    typicalAskPkn: round2(row.ask_pkn),
    // High-end inferred "sales" are often a pricey listing that was pulled;
    // anything above 3× the printing's typical ask gets a caveat.
    unverified: Number(row.ask_pkn) > 0 && Number(row.median_pkn) > Number(row.ask_pkn) * RECENT_SALE_VERIFY_RATIO
      ? true
      : undefined,
  }));
  return {
    status: 'ok',
    today: todayIso(),
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    window: { days, from: daysAgoIso(days), to: daysAgoIso(0) },
    filters: {
      sort,
      language: language || 'all',
      graded,
      subject: tokens.join(' ') || undefined,
      minPricePkn: minPricePkn || undefined,
    },
    sales,
    note: sales.length
      ? 'Each row is one day × condition × language slice; price = that day\'s median sale price. unverified = more than 3× the printing\'s typical 14-day ask (may be a pulled listing, not a sale) — caveat it.'
      : `No sale matching these filters in the last ${days} days.`,
    basis: 'CardTrader inferred sales (cardtrader_sold_daily); outlier lots above 20× the recent ask dropped',
  };
}

/**
 * An artist's cards ranked by price or sales ("the most expensive cards by
 * this artist" on a card desk). The artist comes from params.artist or from
 * the catalog row of params.cardId, so Poko never has to ask who drew it.
 * Price = 90-day ungraded sold median when it is sane, else the median ask.
 */
async function artistCards(params = {}) {
  let artistInput = cleanText(params.artist, 80);
  const cardId = cleanText(params.cardId, 20);
  let fromCard = null;
  if (!artistInput && /^\d+$/.test(cardId)) {
    const rows = await queryRows(
      `select artist, name, set_name from marketplace_search_candidates where card_id = $1 limit 1`,
      [cardId],
    );
    artistInput = cleanText(rows[0]?.artist, 80);
    if (!artistInput) return { status: 'not_found', error: 'no artist recorded for that card', cardId };
    // Stated outright: with only "cards by <artist>" a model still told the
    // user it had no confirmed illustrator for the open card.
    fromCard = {
      cardId,
      name: rows[0]?.name || '',
      setName: rows[0]?.set_name || '',
      illustrator: artistInput,
      note: `${rows[0]?.name || 'This card'}${rows[0]?.set_name ? ` (${rows[0].set_name})` : ''} is illustrated by ${artistInput} (Pokoin catalog).`,
    };
  }
  if (!artistInput) return { status: 'invalid', error: 'artist or cardId required' };

  const artistRows = await queryRows(
    `select artist, count(*)::int as cards
       from marketplace_search_candidates
      where item_kind <> 'product' and artist <> ''
        and (artist = $1 or artist ilike $2)
      group by artist
      order by (artist = $1) desc, cards desc
      limit 5`,
    [artistInput, fuzzyArtistPattern(artistInput)],
  );
  if (!artistRows.length) return { status: 'not_found', error: 'no artist matches that name' };
  const exact = artistRows.find((r) => r.artist.toLowerCase() === artistInput.toLowerCase());
  if (!exact && artistRows.length > 1) {
    return {
      status: 'ambiguous',
      artists: artistRows.map((r) => ({ artist: r.artist, cards: r.cards })),
      note: 'Ask one concise clarification question; do not silently resolve.',
    };
  }
  const artist = (exact || artistRows[0]).artist;
  const artistCardCount = Number((exact || artistRows[0]).cards) || 0;
  const sort = /^(cheap|cheapest|asc|low)/i.test(cleanText(params.sort, 20)) ? 'cheapest'
    : /^(sold|sales|popular|volume)/i.test(cleanText(params.sort, 20)) ? 'sold'
      : 'expensive';
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 20);
  const language = cleanText(params.language, 40) ? normalizeLanguage(params.language).code : null;

  const rows = await queryRows(
    `with art as (
       select s.card_id, s.name, s.set_name, s.artist, s.item_kind, s.card_number,
              s.card_id / 2 as blueprint_id
         from marketplace_search_candidates s
        where s.artist = $1 and s.item_kind = 'single' and s.card_id % 2 = 0
     ), sold as (
       select d.blueprint_id,
              sum(d.sold_qty)::int as sold_qty,
              percentile_cont(0.5) within group (order by d.median_pkn) as median_pkn,
              max(d.observed_day) as last_sale_day
         from cardtrader_sold_daily d
         join art on art.blueprint_id = d.blueprint_id
        where d.observed_day >= current_date - interval '90 days'
          and d.sold_qty > 0
          and not d.graded
          and ($2::text is null or d.language = $2)
        group by d.blueprint_id
     ), asks as (
       select a.blueprint_id,
              percentile_cont(0.5) within group (order by coalesce(a.min_price_pkn, a.median_price_pkn)) as ask_pkn,
              (array_agg(coalesce(a.min_price_pkn, a.median_price_pkn) order by a.observed_day desc))[1] as current_ask_pkn
         from cardtrader_blueprint_daily_analytics a
         join art on art.blueprint_id = a.blueprint_id
        where a.observed_day >= current_date - interval '${SOLD_REFERENCE_ASK_DAYS} days'
          and coalesce(a.min_price_pkn, a.median_price_pkn) > 0
        group by a.blueprint_id
     )
     select art.card_id, art.name, art.set_name, art.artist, art.item_kind, art.card_number,
            sold.sold_qty, sold.median_pkn, sold.last_sale_day, asks.current_ask_pkn,
            (sold.median_pkn is not null and ${plausibleSold('sold.median_pkn', '$3')}) as sold_ok
       from art
       left join sold on sold.blueprint_id = art.blueprint_id
       left join asks on asks.blueprint_id = art.blueprint_id
      where sold.median_pkn is not null or ($2::text is null and asks.current_ask_pkn > 0)`,
    [artist, language, TOP_SELLERS_MAX_SOLD_TO_ASK],
  );

  const cards = rows
    .map((row) => {
      const soldOk = row.sold_ok === true && Number(row.median_pkn) > 0;
      const ask = Number(row.current_ask_pkn);
      // A lone placeholder listing can be the lowest ask (a common Drowzee at
      // 1,402,700 PKN), so an unsold card only counts below the unverified cap.
      const askOk = !language && ask > 0 && ask < SOLD_UNVERIFIED_MAX_PKN;
      const pricePkn = soldOk ? Number(row.median_pkn) : askOk ? ask : null;
      if (pricePkn == null) return null;
      return {
        ...candidateFromRow(row),
        pricePkn: round2(pricePkn),
        priceEur: round2(pricePkn * PKN_EUR_RATE),
        priceBasis: soldOk ? 'sold_median_90d' : 'lowest_ask',
        soldQty90d: soldOk ? Number(row.sold_qty) || 0 : 0,
        lowestAskPkn: round2(row.current_ask_pkn),
        lastSaleDay: soldOk && row.last_sale_day ? String(row.last_sale_day).slice(0, 10) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (sort === 'cheapest' ? a.pricePkn - b.pricePkn
      : sort === 'sold' ? b.soldQty90d - a.soldQty90d || b.pricePkn - a.pricePkn
        : b.pricePkn - a.pricePkn))
    .slice(0, limit);

  return {
    status: 'ok',
    artist,
    ...(fromCard ? { fromCard } : {}),
    artistCardCount,
    pricedCards: rows.length,
    sort,
    language: language || 'all',
    basis: 'price = 90-day ungraded sold median (CardTrader) when plausible against the ask history, else the latest lowest ask; priceBasis says which',
    priceUnit: 'PKN',
    pknEurRate: PKN_EUR_RATE,
    cards,
    ...(cards.length ? {} : { note: `No priced ${artist} singles${language ? ` in ${language}` : ''} right now.` }),
  };
}

// Series prefix of an expansion code (official_id) → era. Western and JP
// codes share most prefixes; CS* are simplified-Chinese releases.
const ERA_BY_CODE = [
  [/^tk-bw/, 'Black & White'],
  [/^tk-dp/, 'Diamond & Pearl'],
  [/^tk-hs/, 'HeartGold & SoulSilver'],
  [/^tk-xy/, 'XY'],
  [/^(base|gym|neo|ecard|si|web|vs|e)$/, 'Wizards of the Coast'],
  [/^(ex|pop|tk|pcg|adv)$/, 'EX'],
  [/^(dp|pt|pl|dpbp)$/, 'Diamond & Pearl'],
  [/^(hgss|col|l|ll|hsp)$/, 'HeartGold & SoulSilver'],
  [/^(bw|dv)$/, 'Black & White'],
  [/^(xy|xya|g|dc|cp)$/, 'XY'],
  [/^(sm|sma|smp|det|csm)$/, 'Sun & Moon'],
  [/^(swsh|cel|pgo|ru|s|sh|sp|sj|sld|sll|sn|spz|spd|cs|cbb)$/, 'Sword & Shield'],
  [/^(sv|sve|zsv|rsv|csv)/, 'Scarlet & Violet'],
  [/^(me|mee|m|mc)$/, 'Mega Evolution'],
];

function eraForCode(code) {
  const prefix = String(code || '').toLowerCase().replace(/[0-9].*$/, '');
  if (!prefix) return null;
  for (const [re, era] of ERA_BY_CODE) {
    if (re.test(prefix)) return era;
  }
  return null;
}

const NATIONALITY_BY_LANGUAGE = { JP: 'japanese', ZH: 'chinese', ZHT: 'chinese', KO: 'korean' };

/**
 * Expansion catalog facts: era, nationality (japanese / western / chinese…),
 * release languages, localized names and card counts. Lookup by set name,
 * localized name, alias or code, or list sets by nationality / era.
 */
async function setInfo(params = {}) {
  const query = cleanText(params.setName || params.set || params.query || params.subject, 80);
  const era = cleanText(params.era, 40);
  const languageCode = cleanText(params.language, 40) ? normalizeLanguage(params.language).code : null;
  const nationality = cleanText(params.nationality, 20).toLowerCase()
    || (languageCode && NATIONALITY_BY_LANGUAGE[languageCode]) || '';
  const limit = Math.min(Math.max(Number(params.limit) || (query ? 5 : 20), 1), 40);
  if (!query && !era && !nationality) return { status: 'invalid', error: 'setName, era or nationality required' };

  const values = [nationality || null];
  let queryCondition = '';
  if (query) {
    values.push(query, `%${escapeLike(query)}%`);
    queryCondition = `and (lower(e.name) = lower($2) or lower(e.official_id) = lower($2)
          or e.name ilike $3 or e.official_name ilike $3
          or exists (select 1 from expansion_languages l where l.expansion_id = e.expansion_id and l.localized_name ilike $3)
          or exists (select 1 from marketplace_expansion_aliases a
                      where a.expansion_name = e.name and a.alias ilike $3))`;
  }
  const rows = await queryRows(
    `select e.expansion_id, e.name, e.official_id, e.official_name, e.nationality, e.kind, e.listed,
            e.catalog_card_count,
            (select array_agg(distinct upper(r.language) order by upper(r.language))
               from expansion_release_languages r where r.expansion_id = e.expansion_id) as release_languages,
            (select jsonb_object_agg(l.language, l.localized_name)
               from expansion_languages l where l.expansion_id = e.expansion_id) as localized_names
       from pokoin_pokemon_expansions e
      where e.kind in ('official', 'promo', 'subset')
        and ($1::text is null or e.nationality = $1)
        ${queryCondition}
      order by ${query ? '(lower(e.name) = lower($2)) desc,' : ''} e.catalog_card_count desc nulls last, e.name
      limit 400`,
    values,
  );

  const sets = rows
    .map((row) => ({
      name: row.name || '',
      officialName: row.official_name || '',
      code: row.official_id || '',
      era: eraForCode(row.official_id),
      nationality: row.nationality || '',
      kind: row.kind || '',
      onMarketplace: Boolean(row.listed),
      cardCount: Number(row.catalog_card_count) || 0,
      releaseLanguages: Array.isArray(row.release_languages) ? row.release_languages : [],
      localizedNames: row.localized_names && typeof row.localized_names === 'object' ? row.localized_names : {},
    }))
    .filter((set) => !era || (set.era && set.era.toLowerCase().includes(era.toLowerCase())))
    // Western sets list their release languages; JP / CN nationality is filtered in SQL.
    .filter((set) => !languageCode || NATIONALITY_BY_LANGUAGE[languageCode]
      || set.releaseLanguages.includes(languageCode))
    .slice(0, limit);

  if (!sets.length) {
    return {
      status: 'not_found',
      error: 'no expansion matches',
      note: 'Ask for the exact set name (English, Japanese or localized) or its code.',
    };
  }
  return {
    status: 'ok',
    filters: { query: query || undefined, era: era || undefined, nationality: nationality || undefined },
    eras: ERA_BY_CODE.map(([, label]) => label).filter((label, i, all) => all.indexOf(label) === i),
    sets,
  };
}

const TOOLS = {
  resolve_card: resolveCard,
  card_quote: cardQuote,
  card_ocr: cardOcr,
  card_liquidity: cardLiquidity,
  collection_quote: collectionQuote,
  suggest_cards: suggestCards,
  market_snapshot: marketSnapshot,
  top_movers: topMovers,
  top_sellers: topSellers,
  card_sales: cardSales,
  deal_check: dealCheck,
  set_sales: setSales,
  recent_sales: recentSales,
  artist_cards: artistCards,
  set_info: setInfo,
};

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function serviceToken() {
  // POKO_MARKET_SERVICE_TOKEN is the dedicated name; POKONTACT_SERVICE_TOKEN
  // is the same secret already provisioned in the Pi container env (see
  // docs/poko-handoff.md — Hermes POKO_API_TOKEN shares the value).
  return String(process.env.POKO_MARKET_SERVICE_TOKEN || process.env.POKONTACT_SERVICE_TOKEN || '').trim();
}

function timingSafeEqualText(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''));
  if (!match) return false;
  return timingSafeEqualText(match[1].trim(), expected);
}

function sendJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

module.exports = async function handler(req, res) {
  if (!serviceToken()) {
    sendJson(res, 503, { error: 'poko-market not configured: POKO_MARKET_SERVICE_TOKEN missing' });
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { error: 'POST only' });
    return;
  }
  const tool = cleanText(req.body?.tool, 40);
  const run = TOOLS[tool];
  if (!run) {
    sendJson(res, 400, { error: `unknown tool; expected one of ${Object.keys(TOOLS).join(', ')}` });
    return;
  }
  const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
  console.log('poko-market request', { tool, params });
  try {
    const result = await run(params);
    const status = result.status === 'invalid' ? 400
      : result.status === 'not_found' ? 404
      : result.status === 'ambiguous' ? 200
      : result.status === 'unsupported' ? 422
      : 200;
    sendJson(res, status, { ok: true, tool, today: todayIso(), ...result });
  } catch (error) {
    console.error('poko-market tool failed', { tool, error: String(error?.message || error).slice(0, 300) });
    sendJson(res, 500, { ok: false, tool, error: 'market query failed' });
  }
};

module.exports._test = {
  ROUTE_PATH,
  CONDITIONS,
  LANGUAGES,
  cleanText,
  todayIso,
  daysAgoIso,
  escapeLike,
  fuzzyArtistPattern,
  normalizeCondition,
  normalizeLanguage,
  blueprintIdFromCardId,
  confidenceForSample,
  liquidityBands,
  normalizeRarity,
  eraForCode,
  buildSoldSummary,
  soldFlag,
  soldFacetFromParams,
  soldStats,
  resolveFacet,
  dealVerdict,
  priceStrategies,
  candidateFromRow,
  dedupeArtworkVersions,
  isAuthorized,
  TOOLS,
};
