import { getJson } from './api.js';
import { CONDITIONS } from './card-desk.js';
import { saveCardPriceHistory } from './price-history-cache.js';

/**
 * The price sources the card-desk graph plots beside the CardTrader sold median.
 * The browser never converts a currency: a source is plotted only when the API
 * already answered in PKN, so a response without those fields simply has one
 * line less. Pokoin is one of them: its own cheapest live listing, per day.
 */

const DAY_MS = 86_400_000;

/** The earliest day any source has history for. */
export const PRICE_HISTORY_FIRST_DAY = '2024-02-08';

/** The range buttons, in the order the graph shows them. `days: 0` is `all`. */
export const PRICE_SOURCE_RANGES = [
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 90 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All', days: 0 },
];

export const PRICE_HISTORY_DEFAULT_RANGE = '3m';

/**
 * The fetched lines, in legend order. `gapDays` is how far apart two of the
 * source's own days may be before the graph breaks the line and bridges the
 * break: TCGplayer quotes daily, Cardmarket's trend is weekly, the CardTrader
 * lowest ask moves whenever a listing does. `carry` says how a hover reads a
 * day the source did not quote: `near` the closest day inside the gap,
 * `onOrBefore` the last one it published (a weekly trend stands until replaced),
 * or `none` — a day it did not quote has no price and the hover says so.
 */
/**
 * Pokoin's own listings: the cheapest live one at the end of every day, and the
 * desk's `nowPoint` as the line's last point. Solid yellow, the desk's colour.
 */
export const POKOIN_SOURCE = {
  key: 'pokoin',
  label: 'Pokoin',
  short: 'PK',
  color: 'var(--yellow)',
  dashed: false,
  gapDays: 3,
  carry: 'near',
};

export const PRICE_SOURCES = [
  { key: 'tcgplayer', label: 'TCGplayer', short: 'TP', color: '#8ab4ff', dashed: false, gapDays: 10, carry: 'near' },
  // The trend is one number per product, every grade and language in it: said
  // beside a grade line below it, a plain "Cardmarket" would read as a grade.
  { key: 'cardmarket', label: 'Cardmarket trend', short: 'CMt', color: '#ff7a59', dashed: false, gapDays: 99, carry: 'onOrBefore' },
  { key: 'cardtrader_ask', label: 'CT lowest ask', short: 'CT ask', color: '#d6c2ff', dashed: true, gapDays: 3, carry: 'near' },
  POKOIN_SOURCE,
];

/**
 * Cardmarket's own offer day: the cheapest live ask of one grade floor, in one
 * language, collected daily for the cards the desk shows. It is the one line
 * whose label is not fixed — `Cardmarket · NM · EN` says what was asked, because
 * the trend beside it is the same shop without those facets. A mint green of its
 * own, solid: the same shop, a different number. Not a `PRICE_SOURCES` entry,
 * because that array is the legend of the sources whose line never changes
 * facets; this one is drawn next to the trend by `priceSourceSeries`.
 *
 * `gapDays` 2 and no carry: a day the collector did not reach has no price, and
 * quoting the last one for it would put a price on a day nothing was offered.
 */
export const CARDMARKET_OFFERS_SOURCE = {
  key: 'cardmarket_offers',
  label: 'Cardmarket offers',
  short: 'CM·offer',
  color: '#4fdcb0',
  dashed: false,
  gapDays: 2,
  carry: 'none',
};

/**
 * The grade floors the daily table keeps, best first — the order of its
 * `series`. The desk's own grades are Cardmarket's letter for letter
 * (reports/cm-conditions/site-side.md §2.2), so this is `CONDITIONS` without its
 * "any condition" row: not a table of its own to keep in step with the chips.
 */
export const CM_OFFER_FLOORS = CONDITIONS.filter((row) => row.value).map((row) => row.value);

/**
 * The languages Cardmarket is collected in. The desk lists `ID`, `TH` and `VI`
 * too, and those are never stored: asking one would be a parameter error that
 * costs every other line of the graph.
 */
export const CM_OFFER_LANGUAGES = ['EN', 'FR', 'DE', 'ES', 'IT', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT', 'JP'];

/** What the server answers when asked for no facet at all. */
export const CM_OFFER_DEFAULT_CONDITION = 'NM';
export const CM_OFFER_DEFAULT_LANGUAGE = 'EN';

/**
 * The facet a request carries: the floor of a picked grade and the picked
 * language, and the defaults for anything the daily table does not keep — no
 * floor ("any condition") and an uncollected language both read as the default.
 */
export function cmOfferFacet(condition, language) {
  const want = String(condition || '').trim().toUpperCase();
  const code = String(language || '').trim().toUpperCase();
  return {
    condition: CM_OFFER_FLOORS.find((floor) => floor.toUpperCase() === want) || CM_OFFER_DEFAULT_CONDITION,
    language: CM_OFFER_LANGUAGES.includes(code) ? code : CM_OFFER_DEFAULT_LANGUAGE,
  };
}

/** A `fields=graph` answer of a long window is one point per ISO week. */
export const PRICE_HISTORY_GRAPH_FIELDS = 'graph';
const WEEK_DAYS = 7;

/**
 * How far apart two of a source's plotted days may be. A weekly answer moves
 * every point 7 days along by itself, so the source's own tolerance moves with
 * it: a card that quotes daily and is thinned weekly keeps one unbroken line,
 * and a week that is really missing still breaks it.
 */
export function graphGapDays(source, bucket) {
  const gapDays = Number(source?.gapDays) || 0;
  return bucket === 'week' ? gapDays + WEEK_DAYS : gapDays;
}

function isIsoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/** `isoDay` moved `days` back, still a UTC calendar day. */
function shiftIsoDay(isoDayValue, days) {
  const [year, month, day] = String(isoDayValue).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The window a range button asks for: `to` is today and `from` is `days` days
 * before it, so `3m` on 2026-11-16 is `{ from: '2026-08-18', to: '2026-11-16' }`.
 * An unknown key falls back to the default range.
 */
export function priceHistoryRange(rangeKey, todayIso) {
  const found = PRICE_SOURCE_RANGES.find((row) => row.key === rangeKey)
    || PRICE_SOURCE_RANGES.find((row) => row.key === PRICE_HISTORY_DEFAULT_RANGE);
  const to = isIsoDay(todayIso) ? String(todayIso) : new Date().toISOString().slice(0, 10);
  return {
    key: found.key,
    from: found.days > 0 ? shiftIsoDay(to, found.days) : PRICE_HISTORY_FIRST_DAY,
    to,
  };
}

/**
 * One card's price history over a window, or `null` when it is unavailable: the
 * graph then keeps showing the sold lines alone. Never throws.
 *
 * `fields=graph` asks for the small answer: the numbers the graph plots, one per
 * day (or per ISO week for a long window), with TCGplayer already narrowed to
 * the one series `reverse` picks. A server that does not know the parameter still
 * answers the full shape, which reads the same way here.
 *
 * `cmCondition`/`cmLanguage` are the Cardmarket facet the desk plots, asked in
 * the words the offers leg answers in: always sent, so the window the arrow
 * warmer keeps is the same read the plain-facet desk makes and not two variants
 * of it. A server that does not know them ignores them.
 */
export async function fetchCardPriceHistory(cardId, {
  from, to, reverse, cmCondition, cmLanguage, signal,
} = {}) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) {
    return null;
  }
  const facet = cmOfferFacet(cmCondition, cmLanguage);
  const params = new URLSearchParams({ cardId: id });
  if (isIsoDay(from)) {
    params.set('from', from);
  }
  if (isIsoDay(to)) {
    params.set('to', to);
  }
  params.set('fields', PRICE_HISTORY_GRAPH_FIELDS);
  params.set('cmCondition', facet.condition);
  params.set('cmLanguage', facet.language);
  if (reverse === true) {
    params.set('reverse', '1');
  }
  try {
    const data = await getJson(`/api/marketplace-card-price-history?${params}`, { signal });
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

/**
 * A neighbour's graph window, asked ahead by the arrow warmer (PH-R034 P5) so the
 * plot is already on this device when the click lands. It asks exactly what the
 * neighbour desk asks first — the default window of the plain facet — and stores
 * it under the key its `peekCardPriceHistory` reads, so nothing is asked twice.
 * No `_=`: that read is the one the edge is allowed to answer from its cache.
 *
 * `silver` is the gate, and it lives here rather than at each call site because
 * the history is a Silver feature: an account that is not Silver asks nothing and
 * writes nothing, in the warmer exactly as on the desk.
 */
export async function warmCardPriceHistory(cardId, { signal, silver = () => true } = {}) {
  if (!silver()) return null;
  const { key: range, from, to } = priceHistoryRange(PRICE_HISTORY_DEFAULT_RANGE, new Date().toISOString().slice(0, 10));
  const history = await fetchCardPriceHistory(cardId, { from, to, signal });
  if (!history) return null;
  const entry = { range, from, to, history };
  saveCardPriceHistory(cardId, range, entry);
  return entry;
}

/** `[{ day, pkn }]`, oldest first, days without a positive price dropped. */
function pricedDays(rows, valueOf) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ day: String(row?.day || ''), pkn: Number(valueOf(row)) }))
    .filter((row) => isIsoDay(row.day) && Number.isFinite(row.pkn) && row.pkn > 0)
    .sort((a, b) => (a.day < b.day ? -1 : (a.day > b.day ? 1 : 0)));
}

function dayRowsOf(row) {
  return Array.isArray(row?.days) ? row.days : [];
}

/**
 * TCGplayer answers with one series per product and subtype. A reverse-holo pick
 * reads the reverse series; every other pick reads a series that is not one.
 * Inside the preferred group it is the series with the most days that carry a
 * market price, and the one with the most rows when those tie; with no series in
 * the preferred group at all, the whole answer is the pool. That is the server's
 * `chosen_series`, read from the same answer.
 *
 * `{ days, lastObservedDay, lastListing }`: the days the line is drawn from, plus
 * the answer's own word for where the series stopped being priced. Both are absent
 * for a series priced through its last day, so a source that really ended still
 * ends.
 */
function tcgplayerSeries(tcgplayer, reverse) {
  const none = { days: [], lastObservedDay: '', lastListing: null };
  const series = Array.isArray(tcgplayer?.series) ? tcgplayer.series.filter((row) => row && row.days) : [];
  if (!series.length) {
    return none;
  }
  const prefersReverse = (row) => /reverse/i.test(String(row?.subtype || ''));
  const isPriced = (day) => day?.marketPkn !== null && day?.marketPkn !== undefined;
  const rank = (row) => [dayRowsOf(row).filter(isPriced).length, dayRowsOf(row).length];
  const better = (a, b) => {
    const [priced, seen] = rank(a);
    const [bestPriced, bestSeen] = rank(b);
    return priced > bestPriced || (priced === bestPriced && seen > bestSeen);
  };
  const preferred = series.filter((row) => (reverse ? prefersReverse(row) : !prefersReverse(row)));
  const pool = preferred.length ? preferred : series;
  const best = pool.reduce((a, b) => (better(b, a) ? b : a), pool[0]);
  const lastListing = best?.lastListing;
  return {
    days: pricedDays(dayRowsOf(best), (row) => row?.marketPkn),
    lastObservedDay: isIsoDay(best?.lastObservedDay) ? String(best.lastObservedDay) : '',
    lastListing: isIsoDay(lastListing?.day) && Number(lastListing.lowPkn) > 0 ? lastListing : null,
  };
}

/** Cardmarket answers per product; the desk is one product, so `products[0]`. */
function cardmarketDays(cardmarket, reverse) {
  const product = Array.isArray(cardmarket?.products) ? cardmarket.products[0] : null;
  return pricedDays(dayRowsOf(product), (row) => {
    const foil = Number(row?.trendFoilPkn);
    if (reverse && Number.isFinite(foil) && foil > 0) {
      return foil;
    }
    return row?.trendPkn;
  });
}

function cardtraderAskDays(cardtrader) {
  return pricedDays(dayRowsOf(cardtrader), (row) => row?.lowestAskPkn);
}

/** Pokoin's own cheapest live listing per day: `pokoin.days[*].lowestAskPkn`. */
function pokoinAskDays(pokoin) {
  return pricedDays(dayRowsOf(pokoin), (row) => row?.lowestAskPkn);
}

/**
 * The offered day of one floor: `cardmarketOffers.series[*]` holds a series per
 * floor the window has days for, best grade first. A `fields=graph` answer holds
 * only the floor that was asked, so a full answer and a graph answer of the same
 * facet read the same way; a floor the answer has no series for is no line.
 */
function cardmarketOffersDays(cardmarketOffers, condition) {
  const series = Array.isArray(cardmarketOffers?.series) ? cardmarketOffers.series : [];
  const wanted = series.find((row) => String(row?.condition || '') === condition);
  return pricedDays(dayRowsOf(wanted), (row) => row?.lowestPkn);
}

/** The one line the answer cannot name for itself: the facet that was asked. */
function cardmarketOffersLine(facet) {
  return {
    ...CARDMARKET_OFFERS_SOURCE,
    label: `Cardmarket · ${facet.condition} · ${facet.language}`,
    short: `CM·${facet.condition}`,
  };
}

/**
 * The fetched sources the graph can draw, in legend order, each with
 * `days: [{ day, pkn }]` oldest first. A source whose response has no PKN field
 * for this card (or a status that answered nothing) is left out; `reverse`
 * switches TCGplayer to its reverse series and Cardmarket to its foil trend.
 *
 * The TCGplayer line also carries the answer's `lastObservedDay` and
 * `lastListing`: the graph continues it, dotted and flat, to that day, and the
 * hover quotes the listing under it.
 *
 * `cmCondition`/`cmLanguage` are the facet the answer was read for — they name
 * the Cardmarket offers line and pick its floor out of the series. They come
 * from what was asked, not from what the chips say now, so the lines that are
 * already drawn keep the words that go with them while a new facet loads.
 */
export function priceSourceSeries(history, {
  reverse, cmCondition, cmLanguage,
} = {}) {
  const foil = reverse === true;
  const bucket = history?.bucket === 'week' ? 'week' : 'day';
  const facet = cmOfferFacet(cmCondition, cmLanguage);
  const tcgplayer = tcgplayerSeries(history?.tcgplayer, foil);
  const daysByKey = {
    tcgplayer: tcgplayer.days,
    cardmarket: cardmarketDays(history?.cardmarket, foil),
    cardtrader_ask: cardtraderAskDays(history?.cardtrader),
    pokoin: pokoinAskDays(history?.pokoin),
    cardmarket_offers: cardmarketOffersDays(history?.cardmarketOffers, facet.condition),
  };
  const tailByKey = { tcgplayer: { lastObservedDay: tcgplayer.lastObservedDay, lastListing: tcgplayer.lastListing } };
  const lines = PRICE_SOURCES.map((source) => ({
    ...source,
    gapDays: graphGapDays(source, bucket),
    days: daysByKey[source.key] || [],
    ...tailByKey[source.key],
  }));
  const offers = {
    ...cardmarketOffersLine(facet),
    gapDays: graphGapDays(CARDMARKET_OFFERS_SOURCE, bucket),
    days: daysByKey.cardmarket_offers,
  };
  if (offers.days.length) {
    // Drawn next to the trend it belongs to, whether or not that one has days.
    const guide = lines.findIndex((row) => row.key === 'cardmarket');
    lines.splice(guide < 0 ? lines.length : guide + 1, 0, offers);
  }
  return lines.filter((line) => line.days.length);
}
