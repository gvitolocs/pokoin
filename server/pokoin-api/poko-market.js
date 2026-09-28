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
 *   card_quote       — sold-market estimate from sanitized cardtrader_sold_daily
 *                      aggregates plus current ask signals.
 *   card_liquidity   — deterministic sell-time range from marketplace_card_weights.
 *   collection_quote — artist-level collection estimate with explicit coverage.
 *   market_snapshot  — top sold_qty_7d cards (public aggregates only).
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
    currency: 'EUR',
    median: median,
    p25: p25,
    p75: p75,
    sampleSize: Number(row.sold_qty) || 0,
    lastSaleDay: row.last_sale_day ? String(row.last_sale_day).slice(0, 10) : null,
    methodology: 'median of daily sold medians (cardtrader_sold_daily, sanitized inferred sales)',
    confidence: confidenceForSample(Number(row.sold_qty)),
  };
}

function priceStrategies(summary, asks) {
  if (!summary || summary.confidence === 'none' || summary.confidence === 'low') return null;
  const minAsk = asks && asks.min != null ? asks.min : null;
  const quick = minAsk != null ? Math.min(summary.p25 ?? summary.median, minAsk * 0.95) : summary.p25 ?? summary.median;
  return {
    quickSale: { price: round2(quick), expectedTime: '1-7d' },
    market: { price: summary.median, expectedTime: '1-3w' },
    patient: { price: summary.p75 ?? summary.median, expectedTime: '2-8w' },
  };
}

function candidateFromRow(row) {
  return {
    cardId: String(row.card_id),
    blueprintId: blueprintIdFromCardId(row.card_id),
    name: row.name || '',
    setName: row.set_name || '',
    cardNumber: row.card_number || '',
    artist: row.artist || '',
    itemKind: row.item_kind || '',
  };
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
      `select s.card_id, s.name, s.set_name, s.artist, s.item_kind,
              coalesce(nullif(c.card_number, ''), '') as card_number
         from marketplace_search_candidates s
         left join marketplace_cards c on c.card_id = s.card_id
        where s.item_kind <> 'product'
          and ${conditions.join(' and ')}
        order by s.search_weight desc nulls last, s.name
        limit 7`,
      params2,
    );
    if (rows.length) {
      return {
        status: rows.length === 1 ? 'ok' : 'ambiguous',
        candidates: rows.map(candidateFromRow),
        note: rows.length > 1
          ? 'Multiple printings match; ask the user which one they mean.'
          : undefined,
      };
    }
  }
  return {
    status: 'not_found',
    error: 'no catalog match',
    note: 'The assistant should ask the user to double-check the card name or set.',
  };
}

async function soldSummaryForBlueprint(blueprintId, condition, language, days) {
  const rows = await queryRows(
    `select sum(sold_qty)::int as sold_qty,
            percentile_cont(0.25) within group (order by median_pkn) as p25_daily,
            percentile_cont(0.5) within group (order by median_pkn) as median_daily,
            percentile_cont(0.75) within group (order by median_pkn) as p75_daily,
            max(observed_day) as last_sale_day
       from cardtrader_sold_daily
      where blueprint_id = $1::bigint
        and observed_day >= current_date - ($4::int || ' days')::interval
        and ($2::text is null or condition = $2)
        and ($3::text is null or language = $3)
        and sold_qty > 0`,
    [String(blueprintId), condition, language, days],
  );
  return buildSoldSummary(rows[0]);
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

async function cardQuote(params = {}) {
  const owned = await requireCard(params);
  if (owned.error) return owned.error;
  const card = owned.card;
  const blueprintId = blueprintIdFromCardId(card.cardId);
  if (blueprintId == null) {
    return { status: 'unsupported', error: 'card_quote needs a single card (public even card id)', card };
  }

  const cond = normalizeCondition(params.condition);
  const lang = normalizeLanguage(params.language);

  const variants = [{ condition: cond.primary, language: lang.code, vague: false }];
  if (cond.vague && cond.alternatives.length) {
    variants[0].vague = true;
    variants.push({ condition: cond.alternatives[0], language: lang.code, vague: true });
  }

  const askHistory = await askHistoryForBlueprint(blueprintId, 14);
  const quotes = [];
  for (const variant of variants) {
    const [summary, asks] = await Promise.all([
      soldSummaryForBlueprint(blueprintId, variant.condition, variant.language, 90),
      askSignalForBlueprint(blueprintId),
    ]);
    const liquidity = await cardLiquidity({ cardId: card.cardId });
    quotes.push({
      condition: variant.condition,
      language: variant.language,
      vagueWording: variant.vague || undefined,
      estimate: summary,
      currentAsk: asks,
      liquidity: liquidity.liquidity || undefined,
      strategies: priceStrategies(summary, asks),
      askingPriceOnly: !summary,
    });
  }

  return {
    status: 'ok',
    today: todayIso(),
    card,
    filters: { condition: cond.primary, language: lang.code, conditionVague: cond.vague },
    window: { soldDays: 90, from: daysAgoIso(90), to: daysAgoIso(0) },
    askHistory,
    conditionNote: cond.vague
      ? `Vague condition wording: showing ${cond.primary} and ${cond.alternatives[0]} ranges instead of claiming a grade.`
      : undefined,
    quotes,
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

const TOOLS = {
  resolve_card: resolveCard,
  card_quote: cardQuote,
  card_liquidity: cardLiquidity,
  collection_quote: collectionQuote,
  market_snapshot: marketSnapshot,
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
  buildSoldSummary,
  priceStrategies,
  candidateFromRow,
  isAuthorized,
  TOOLS,
};
