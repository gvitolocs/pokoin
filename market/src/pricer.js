/**
 * The MyPokoin pricer's rules for the web: named strategies, pricing groups
 * and the reprice plan. The server states the same rules in
 * `pokoin_external::pricing` (pokoin-rust/crates/external/src/pricing.rs);
 * keep the two in step (docs/PRICING.md, "Pricer").
 *
 * A strategy (users/{uid}.pricingStrategies) is a named rule for HOW to
 * price, with no scope:
 *   name          required, unique per seller (ignoring case)
 *   source        'cardtrader' | 'pokoin' | 'cardmarket' | 'tcgplayer'
 *   basis         one of the source's bases (`pricerBases`):
 *                 CardTrader 'offers' (the cheapest current offer that shares
 *                 with the listing what `match` asks for) | 'sold' (30-day
 *                 sold median, same toggles); Pokoin 'offers' (the cheapest
 *                 Pokoin ask) | 'sold' (Pokoin's own sales, 90 days);
 *                 Cardmarket 'trend' | 'low' | 'avg1' | 'avg7' | 'avg30'
 *                 (its daily price guide); TCGplayer 'market' | 'low' | 'mid'
 *                 (USD at the day's ECB rate)
 *   match         { condition, language, finish, firstEdition }: one toggle
 *                 each, all on = "All exact" (saved 'matched' before
 *                 2026-11-05), all off = any copy (saved 'cheapest'). Only
 *                 the toggles the source honours count (`sourceSwitches`)
 *   feeExclusive  true: what a seller nets on CardTrader after its commission
 *                 (docs/PRICING.md); false: the CardTrader ask itself. Only
 *                 CardTrader numbers have fees
 *   action        'match' | 'undercut' | 'premium', by amountPct % and amountPkn PKN
 *   rounding      'none' (cents) | 'integer' (nearest) | 'down' | 'up'  (whole PKN)
 *   minPkn        never price below this (after rounding)
 *   activatePaused  a paused listing that gets a price goes on sale
 *
 * A pricing group (`seller_pricing_groups`) is a named set of listings the
 * seller picked, priced by one strategy, on Apply or every day (autoDaily).
 * A listing is in at most one group.
 *
 * Money is stored in PKN; the user surface shows and accepts the seller's
 * currency only (`currencyContext`, `pknToLocal`, `localToPkn`).
 */

export const PRICER_SOURCES = [
  { id: 'cardtrader', label: 'CardTrader', hint: 'Offers and sales on CardTrader' },
  { id: 'pokoin', label: 'Pokoin', hint: 'Listings and sales on Pokoin' },
  { id: 'cardmarket', label: 'Cardmarket', hint: "Cardmarket's daily price guide" },
  { id: 'cardmarketoffers', label: 'Cardmarket sellers', hint: 'Professional and private offers we scanned on Cardmarket' },
  { id: 'tcgplayer', label: 'TCGplayer', hint: 'US prices, converted at the ECB rate' },
];

/**
 * Each source's bases, its default first (server: `pricing::source_bases`).
 * `words` is the basis in a strategy summary (`pricing::source_words`).
 */
const SOURCE_BASES = {
  cardtrader: [
    { id: 'offers', label: 'Current offers', hint: 'The cheapest copy for sale now', words: 'current offers' },
    { id: 'sold', label: 'Sold median', hint: 'Last 30 days', words: 'sold median (30 days)' },
  ],
  pokoin: [
    { id: 'offers', label: 'Cheapest ask', hint: 'Other sellers’ listings now', words: 'cheapest Pokoin ask' },
    { id: 'sold', label: 'Sold median', hint: 'Pokoin sales, last 90 days', words: 'sold median (90 days)' },
  ],
  cardmarket: [
    { id: 'trend', label: 'Trend', hint: 'Cardmarket’s trend price', words: 'trend' },
    { id: 'low', label: 'Lowest ask', hint: 'The cheapest copy for sale', words: 'lowest ask' },
    { id: 'avg1', label: '1-day average', hint: 'Average sale price, last day', words: '1-day average' },
    { id: 'avg7', label: '7-day average', hint: 'Average sale price, last 7 days', words: '7-day average' },
    { id: 'avg30', label: '30-day average', hint: 'Average sale price, last 30 days', words: '30-day average' },
  ],
  cardmarketoffers: [
    { id: 'pro', label: 'Professional offer', hint: 'The cheapest professional or powerseller offer we scanned', words: 'cheapest professional offer' },
    { id: 'private', label: 'Private offer', hint: 'The cheapest private seller offer we scanned', words: 'cheapest private offer' },
  ],
  tcgplayer: [
    { id: 'market', label: 'Market price', hint: 'TCGplayer’s price from recent sales', words: 'market price (USD → EUR)' },
    { id: 'low', label: 'Lowest listing', hint: 'The cheapest copy for sale', words: 'lowest listing (USD → EUR)' },
    { id: 'mid', label: 'Mid price', hint: 'The middle of current listings', words: 'mid price (USD → EUR)' },
  ],
};

/** The bases of a source (unknown: CardTrader's). */
export function pricerBases(source) {
  return SOURCE_BASES[source] || SOURCE_BASES.cardtrader;
}

/** CardTrader's and Pokoin's bases, as before sources had their own. */
export const PRICER_BASES = SOURCE_BASES.cardtrader;

/** Only CardTrader numbers have a seller fee to take off. */
export function sourceHasFees(source) {
  return (source || 'cardtrader') === 'cardtrader';
}

/**
 * The toggles of an 'offers' strategy: what a CardTrader offer must share
 * with the listing to price it. The letters build the comp's `ctMatch` key
 * (server: `price_check::Match::key`).
 */
export const PRICER_MATCHES = [
  { id: 'condition', letter: 'C', label: 'Same condition', hint: 'Other games: this condition or better' },
  { id: 'language', letter: 'L', label: 'Same language' },
  { id: 'finish', letter: 'F', label: 'Same finish', hint: 'Reverse or foil' },
  { id: 'firstEdition', letter: 'E', label: 'Same 1st edition', hint: 'Pokémon' },
];

export const MATCH_EXACT = Object.freeze({ condition: true, language: true, finish: true, firstEdition: true });
export const MATCH_ANY = Object.freeze({ condition: false, language: false, finish: false, firstEdition: false });

/**
 * A strategy's toggles: its `match` (a toggle not sent is on), else from a
 * basis saved before the toggles ('cheapest': all off; else all on).
 */
export function matchOf(strategy) {
  const match = strategy?.match;
  if (match && typeof match === 'object') {
    return Object.fromEntries(PRICER_MATCHES.map(({ id }) => [id, match[id] !== false]));
  }
  return { ...(String(strategy?.basis || '').toLowerCase() === 'cheapest' ? MATCH_ANY : MATCH_EXACT) };
}

/** `''` (any copy) … `'CLFE'` (all exact). */
export function matchKey(match) {
  return PRICER_MATCHES.filter(({ id }) => match?.[id]).map(({ letter }) => letter).join('');
}

/**
 * The toggles a source's data can honour for a basis (server:
 * `pricing::source_switches`): CardTrader all, and so does our own walk of
 * Cardmarket's listing pages; Pokoin's sales condition and language (its
 * cheapest ask is any copy); Cardmarket's guide finish (regular or foil);
 * TCGplayer finish and 1st edition. The rest stay saved, read as off.
 */
export function sourceSwitches(source, basis) {
  const only = (...ids) => Object.fromEntries(PRICER_MATCHES.map(({ id }) => [id, ids.includes(id)]));
  if (source === 'pokoin') return basis === 'sold' ? only('condition', 'language') : only();
  if (source === 'cardmarket') return only('finish');
  if (source === 'tcgplayer') return only('finish', 'firstEdition');
  return { ...MATCH_EXACT };
}

/** Why a toggle is off for a source, for the editor. */
export function switchNote(source) {
  const label = PRICER_SOURCES.find((entry) => entry.id === source)?.label || 'This source';
  return `Not in ${label}’s data`;
}

/** The toggles that count: the strategy's own, less those its source cannot honour. */
export function effectiveMatch(input) {
  const strategy = normalizeStrategy(input);
  const can = sourceSwitches(strategy.source, strategy.basis);
  return Object.fromEntries(PRICER_MATCHES.map(({ id }) => [id, strategy.match[id] && can[id]]));
}

/** All four toggles on. */
export function isAllExact(match) {
  return PRICER_MATCHES.every(({ id }) => match?.[id] === true);
}

/** The toggles in words: "all exact", "any copy", "same condition and language". */
export function matchSummary(match) {
  if (isAllExact(match)) return 'all exact';
  const names = [['condition', 'condition'], ['language', 'language'], ['finish', 'finish'], ['firstEdition', '1st edition']]
    .filter(([id]) => match?.[id])
    .map(([, name]) => name);
  if (!names.length) return 'any copy';
  if (names.length === 1) return `same ${names[0]}`;
  return `same ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const PRICER_ACTIONS = [
  { id: 'match', label: 'Match' },
  { id: 'undercut', label: 'Undercut' },
  { id: 'premium', label: 'Above' },
];

export const PRICER_ROUNDINGS = [
  { id: 'integer', label: 'Nearest' },
  { id: 'down', label: 'Round down' },
  { id: 'up', label: 'Round up' },
  { id: 'none', label: 'Exact' },
];

/**
 * The pricer's display and input currencies (server: `pricing::CURRENCIES`):
 * two-decimal currencies the ECB reference rates cover. PKN stays the unit
 * of the comps, the storage and the listing writes; only the edge converts.
 */
export const PRICER_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK', 'CHF', 'HUF', 'RON', 'BGN', 'CAD', 'AUD',
];

/** What summaries and the editor render before a settings answer arrives. */
export const EUR_CONTEXT = Object.freeze({ code: 'EUR', rate: 1 });

/**
 * The seller's currency and its ECB rate (units per 1 EUR). Without a fresh
 * rate a non-EUR setting reads EUR: never a wrong number under a local label.
 */
export function currencyContext(settings, currencyRate) {
  const code = String(settings?.currency || '').toUpperCase();
  if (code === 'EUR' || !PRICER_CURRENCIES.includes(code)) return { ...EUR_CONTEXT };
  const rate = Number(currencyRate?.rate);
  if (!Number.isFinite(rate) || rate <= 0) return { ...EUR_CONTEXT };
  return { code, rate };
}

/** Stored PKN → the seller's currency (2 PKN = 1 euro cent, × the rate). */
export function pknToLocal(pkn, ctx = EUR_CONTEXT) {
  return ((Number(pkn) || 0) * ctx.rate) / 200;
}

/** What the seller typed, in their currency → PKN to store. */
export function localToPkn(local, ctx = EUR_CONTEXT) {
  return ((Number(local) || 0) * 200) / ctx.rate;
}

const CURRENCY_SIGNS = { EUR: '€', USD: '$', GBP: '£' };

/** A local amount with its symbol or code, two decimals ("€0.15", "7.50 DKK"). */
export function formatLocal(amount, ctx = EUR_CONTEXT) {
  const value = Math.round((Number(amount) || 0) * 100) / 100;
  const sign = CURRENCY_SIGNS[ctx.code];
  return sign ? `${sign}${value.toFixed(2)}` : `${value.toFixed(2)} ${ctx.code}`;
}

// A seller writes an amount freely in a strategy name: "5", "2.5", "1,000",
// "1,000.50" (a comma of three digits groups thousands, else it reads as the
// decimal separator).
const PKN_AMOUNT_TEXT = String.raw`\d+(?:,\d{3})*(?:[.,]\d+)?`;
/** "5 PKN", "5PKN", "1,000 PKN", "2.5 pkn": the amount, then the unit. */
const PKN_UNIT_LAST = new RegExp(`(${PKN_AMOUNT_TEXT})[ \t]*PKN\\b`, 'gi');
/** "PKN 5", "PKN5": the unit, then the amount. */
const PKN_UNIT_FIRST = new RegExp(`\\bPKN[ \t]*(${PKN_AMOUNT_TEXT})`, 'gi');

/** The PKN amount as written in a name, its thousands groups dropped. */
function pknAmountFromText(raw) {
  return Number(String(raw).replace(/,(\d{3})(?!\d)/g, '$1').replace(',', '.')) || 0;
}

/**
 * A strategy name as the pricer shows it: money in the seller's currency,
 * never PKN (D000014) — "Undercut by 5 PKN" reads "Undercut by €0.03", and a
 * bare "PKN" with no amount beside it goes with one adjacent space. Only the
 * display: the saved name and the uniqueness checks keep the text as typed.
 * An empty or missing name comes back empty, so the caller's own fallback
 * ('Strategy', 'No strategy') still applies.
 */
export function localizeStrategyName(name, ctx = EUR_CONTEXT) {
  const text = String(name ?? '');
  if (!text.trim()) return text;
  const money = (_unit, amount) => formatLocal(pknToLocal(pknAmountFromText(amount), ctx), ctx);
  const amounts = text.replace(PKN_UNIT_LAST, money).replace(PKN_UNIT_FIRST, money);
  const spaced = amounts.replace(/[ \t]+PKN\b/gi, '').replace(/\bPKN[ \t]+/gi, '');
  // Nothing around the unit was a space ("…PKN"): drop the unit itself.
  return spaced === amounts ? spaced.replace(/PKN\b/gi, '') : spaced;
}

/** A new strategy's starting point. */
export const DEFAULT_STRATEGY = {
  id: '',
  name: '',
  source: 'cardtrader',
  basis: 'offers',
  match: { ...MATCH_EXACT },
  feeExclusive: true,
  action: 'match',
  amountPct: 0,
  amountPkn: 0,
  rounding: 'integer',
  minPkn: 1,
  activatePaused: true,
};

/** Fixed-point scale of the server's verified rounding core (`ct_fees::SCALE`). */
const SCALE = 100_000_000;
/** The largest comp the server's proofs cover (`ct_fees::MAX_ASK_PKN`). */
const MAX_COMP_PKN = 1_000_000_000_000;

const pick = (value, list, fallback) => (list.some((entry) => entry.id === value) ? value : fallback);
const finite = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== '' && value != null && Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const cents = (value) => Math.round(value * 100) / 100;

/**
 * A stored or edited strategy with every field present and in range. A
 * missing field reads as the server reads it (0, exact, not put on sale),
 * not as DEFAULT_STRATEGY, which only seeds the new-strategy form.
 */
export function normalizeStrategy(input = {}) {
  const raw = input || {};
  const source = pick(String(raw.source || '').toLowerCase(), PRICER_SOURCES, 'cardtrader');
  const bases = pricerBases(source);
  return {
    id: String(raw.id || ''),
    name: String(raw.name || '').trim().slice(0, 80),
    source,
    basis: pick(String(raw.basis || '').toLowerCase(), bases, bases[0].id),
    match: matchOf(raw),
    feeExclusive: raw.feeExclusive !== false,
    action: pick(String(raw.action || '').toLowerCase(), PRICER_ACTIONS, 'match'),
    amountPct: finite(raw.amountPct, 0, 0, 90),
    amountPkn: cents(finite(raw.amountPkn, 0, 0, 1_000_000)),
    rounding: pick(String(raw.rounding || '').toLowerCase(), PRICER_ROUNDINGS, 'none'),
    minPkn: cents(finite(raw.minPkn, 0, 0, 1_000_000)),
    activatePaused: raw.activatePaused === true,
  };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Why a strategy or group name cannot be saved, or '' when it can: it is
 * required and unique among `others` (ignoring case; its own id excluded).
 */
export function nameProblem(name, id, others, kind = 'strategy') {
  const clean = String(name || '').trim();
  if (!clean) return kind === 'group' ? 'Give the group a name.' : 'Give the strategy a name.';
  if ((others || []).some((other) => other?.id !== id && sameName(other?.name, clean))) {
    return `You already have a ${kind} named “${clean}”.`;
  }
  return '';
}

function positive(value) {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The market number a strategy starts from, in PKN, or null (server:
 * `pricing::strategy_comp`). CardTrader numbers are fee-exclusive unless the
 * strategy asks for the ask itself (`…GrossPkn`; an older answer only has
 * the net, which is then used either way). Pokoin offers: the cheapest
 * Pokoin ask, else CardTrader's sold median. Every other number is the
 * comp's `sources[source][basis]` entry under the key of the toggles the
 * source honours; an answer from before `sources` only has CardTrader's sold
 * median, toggles ignored.
 */
export function strategyComp(comp, input) {
  if (!comp) return null;
  const strategy = normalizeStrategy(input);
  const choose = (net, gross) => (strategy.feeExclusive ? positive(net) : positive(gross) ?? positive(net));
  const sold = () => choose(comp.soldMedianPkn, comp.soldMedianGrossPkn);
  const { source, basis } = strategy;
  // undefined: an answer from before the `sources` block.
  const fromSources = () => {
    if (!comp.sources || typeof comp.sources !== 'object') return undefined;
    const entry = comp.sources[source]?.[basis]?.[matchKey(effectiveMatch(strategy))];
    return entry ? choose(entry.pkn, entry.grossPkn) : null;
  };
  if (source === 'pokoin' && basis === 'offers') return positive(comp.pokoinCheapestPkn) ?? sold();
  if (source === 'cardtrader' && basis === 'sold') return fromSources() ?? (comp.sources ? null : sold());
  if (source !== 'cardtrader') return fromSources() ?? null;
  const key = matchKey(strategy.match);
  // The offer of the strategy's toggles; no entry: no such offer.
  if (comp.ctMatch && typeof comp.ctMatch === 'object') {
    const entry = comp.ctMatch[key];
    return entry ? choose(entry.pkn, entry.grossPkn) : null;
  }
  // An answer from before `ctMatch`: only the exact copy and the cheapest one.
  if (key === 'CLFE') return choose(comp.ctMatchedPkn, comp.ctMatchedGrossPkn);
  if (key === '') return choose(comp.ctCheapestPkn, comp.ctCheapestGrossPkn);
  return null;
}

/**
 * The rounding and the floor in fixed point, as the server's verified core
 * (`ct_fees::floor_price_rounded`): a target in 1 / SCALE PKN rounded in its
 * mode, never under the floor.
 */
export function floorPriceRounded(targetScaled, rounding, floorScaled) {
  let rounded = targetScaled;
  if (rounding === 'integer') rounded = Math.floor((targetScaled + SCALE / 2) / SCALE) * SCALE;
  else if (rounding === 'down') rounded = Math.floor(targetScaled / SCALE) * SCALE;
  else if (rounding === 'up') rounded = Math.ceil(targetScaled / SCALE) * SCALE;
  // `+ 0` turns the -0 of Math.ceil(-0.5) into 0, as the integer core has it.
  return (rounded < floorScaled ? floorScaled : rounded) + 0;
}

/**
 * The new price for a comp: undercut or premium, then rounding and the
 * floor (the floor always wins), then cents. Null for no comp or a target
 * of 0 or less (server: `pricing::evaluate_strategy_target`).
 */
export function strategyTarget(compPkn, input) {
  const comp = positive(compPkn);
  if (comp == null || comp > MAX_COMP_PKN) return null;
  const strategy = normalizeStrategy(input);
  let target = comp;
  if (strategy.action === 'undercut') target = comp * (1 - strategy.amountPct / 100) - strategy.amountPkn;
  else if (strategy.action === 'premium') target = comp * (1 + strategy.amountPct / 100) + strategy.amountPkn;
  const result = floorPriceRounded(Math.round(target * SCALE), strategy.rounding, Math.round(strategy.minPkn * SCALE));
  if (!(result > 0)) return null;
  return cents(result / SCALE);
}

/** The steps of a strategy on one comp, for the editor's worked example. */
export function strategyExample(compPkn, input) {
  const strategy = normalizeStrategy(input);
  const comp = positive(compPkn);
  if (comp == null) return null;
  let adjusted = comp;
  if (strategy.action === 'undercut') adjusted = comp * (1 - strategy.amountPct / 100) - strategy.amountPkn;
  else if (strategy.action === 'premium') adjusted = comp * (1 + strategy.amountPct / 100) + strategy.amountPkn;
  return { comp, adjusted: cents(adjusted), target: strategyTarget(comp, strategy) };
}

const rowStatus = (row) => String(row?.status || 'active').toLowerCase();

/**
 * The reprice plan of `rows` under one strategy: an entry per listing whose
 * price moves (or that goes on sale), with the comp it came from.
 * `compFor(row)` returns the row's price-check entry. Listings without a
 * comp are counted, never guessed; sold-out or removed listings are skipped.
 */
export function planReprice(rows, compFor, input) {
  const strategy = normalizeStrategy(input);
  const plan = [];
  let scoped = 0;
  let noComp = 0;
  let unchanged = 0;
  for (const row of rows || []) {
    const status = rowStatus(row);
    if (status !== 'active' && status !== 'paused') continue;
    scoped += 1;
    const comp = compFor(row);
    const compPkn = strategyComp(comp, strategy);
    const target = strategyTarget(compPkn, strategy);
    if (target == null) {
      noComp += 1;
      continue;
    }
    const current = Number(row?.pricePkn ?? row?.price_pkn ?? 0) || 0;
    const activate = strategy.activatePaused && status === 'paused';
    if (Math.abs(target - current) < 0.01 && !activate) {
      unchanged += 1;
      continue;
    }
    plan.push({ row, current, compPkn, askPkn: positive(comp?.ctMatchedGrossPkn), target, activate });
  }
  return { plan, scoped, noComp, unchanged };
}

/** The listing update one plan entry sends. */
export function planUpdate(entry) {
  return entry.activate ? { pricePkn: entry.target, status: 'active' } : { pricePkn: entry.target };
}

const trimNumber = (value) => String(cents(value));

/**
 * One line describing a strategy (server: `pricing::strategy_summary`, which
 * stays in PKN); money renders in the seller's currency, EUR by default.
 */
export function strategySummary(input, ctx = EUR_CONTEXT) {
  const strategy = normalizeStrategy(input);
  const { source, basis } = strategy;
  const parts = [PRICER_SOURCES.find((entry) => entry.id === source).label];
  // CardTrader's offers read as before: "CardTrader · all exact · …".
  if (!(source === 'cardtrader' && basis === 'offers')) {
    parts.push(pricerBases(source).find((entry) => entry.id === basis).words);
  }
  if (!(source === 'pokoin' && basis === 'offers')) parts.push(matchSummary(effectiveMatch(strategy)));
  if (sourceHasFees(source)) parts.push(strategy.feeExclusive ? 'net of CardTrader fees' : 'CardTrader ask');
  const money = (pkn) => formatLocal(pknToLocal(pkn, ctx), ctx);
  const flat = (sign) => (strategy.amountPkn > 0 ? ` ${sign} ${money(strategy.amountPkn)}` : '');
  if (strategy.action === 'undercut') parts.push(`undercut ${trimNumber(strategy.amountPct)}%${flat('−')}`);
  else if (strategy.action === 'premium') parts.push(`+${trimNumber(strategy.amountPct)}%${flat('+')}`);
  else parts.push('match');
  const rounding = { integer: 'nearest', down: 'rounded down', up: 'rounded up' }[strategy.rounding];
  if (rounding) parts.push(rounding);
  if (strategy.minPkn > 0) parts.push(`min ${money(strategy.minPkn)}`);
  return parts.join(' · ');
}

/** `{ listingId: groupId }` from the server's `[[listingId, groupId]]`. */
export function membershipMap(memberships) {
  const map = new Map();
  for (const pair of memberships || []) {
    if (Array.isArray(pair) && pair[0] && pair[1]) map.set(String(pair[0]), String(pair[1]));
  }
  return map;
}

/** Listings in no group, out of `rows`. */
export function ungroupedCount(rows, memberships) {
  let count = 0;
  for (const row of rows || []) {
    const status = rowStatus(row);
    if ((status === 'active' || status === 'paused') && !memberships.has(String(row?.id || ''))) count += 1;
  }
  return count;
}

/** One line for a group's last apply. */
export function lastAppliedLine(group) {
  const when = group?.lastAppliedAt ? new Date(group.lastAppliedAt) : null;
  if (!when || Number.isNaN(when.getTime())) return 'Never applied';
  const last = group.lastApplied || {};
  const how = last.trigger === 'daily' ? 'Repriced daily' : last.trigger === 'batch' ? 'Priced on arrival' : 'Applied';
  const day = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const changed = Number(last.changed) || 0;
  return `${how} ${day} · ${changed} ${changed === 1 ? 'price' : 'prices'}`;
}
