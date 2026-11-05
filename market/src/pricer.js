/**
 * The MyPokoin pricer's rules for the web: named strategies, pricing groups
 * and the reprice plan. The server states the same rules in
 * `pokoin_external::pricing` (pokoin-rust/crates/external/src/pricing.rs);
 * keep the two in step (docs/PRICING.md, "Pricer").
 *
 * A strategy (users/{uid}.pricingStrategies) is a named rule for HOW to
 * price, with no scope:
 *   name          required, unique per seller (ignoring case)
 *   source        'cardtrader' | 'pokoin'
 *   basis         'offers'   the cheapest current offer that shares with the
 *                            listing what `match` asks for (CardTrader); for
 *                            Pokoin, the cheapest Pokoin ask
 *                 'sold'     the 30-day sold median
 *   match         { condition, language, finish, firstEdition }: one toggle
 *                 each, all on = "All exact" (saved 'matched' before
 *                 2026-11-05), all off = any copy (saved 'cheapest')
 *   feeExclusive  true: what a seller nets on CardTrader after its commission
 *                 (docs/PRICING.md); false: the CardTrader ask itself
 *   action        'match' | 'undercut' | 'premium', by amountPct % and amountPkn PKN
 *   rounding      'none' (cents) | 'integer' (nearest) | 'down' | 'up'  (whole PKN)
 *   minPkn        never price below this (after rounding)
 *   activatePaused  a paused listing that gets a price goes on sale
 *
 * A pricing group (`seller_pricing_groups`) is a named set of listings the
 * seller picked, priced by one strategy, on Apply or every day (autoDaily).
 * A listing is in at most one group.
 */

export const PRICER_SOURCES = [
  { id: 'cardtrader', label: 'CardTrader' },
  { id: 'pokoin', label: 'Pokoin' },
];

export const PRICER_BASES = [
  { id: 'offers', label: 'Current offers', hint: 'The cheapest copy for sale now' },
  { id: 'sold', label: 'Sold median', hint: 'Last 30 days' },
];

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
  { id: 'integer', label: 'Nearest PKN' },
  { id: 'down', label: 'Round down' },
  { id: 'up', label: 'Round up' },
  { id: 'none', label: 'Exact' },
];

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
  return {
    id: String(raw.id || ''),
    name: String(raw.name || '').trim().slice(0, 80),
    source: pick(String(raw.source || '').toLowerCase(), PRICER_SOURCES, 'cardtrader'),
    basis: String(raw.basis || '').toLowerCase() === 'sold' ? 'sold' : 'offers',
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
 * the net, which is then used either way).
 */
export function strategyComp(comp, input) {
  if (!comp) return null;
  const strategy = normalizeStrategy(input);
  const choose = (net, gross) => (strategy.feeExclusive ? positive(net) : positive(gross) ?? positive(net));
  const sold = () => choose(comp.soldMedianPkn, comp.soldMedianGrossPkn);
  if (strategy.source === 'pokoin') {
    if (strategy.basis === 'sold') return sold();
    return positive(comp.pokoinCheapestPkn) ?? sold();
  }
  if (strategy.basis === 'sold') return sold();
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

/** One line describing a strategy (server: `pricing::strategy_summary`). */
export function strategySummary(input) {
  const strategy = normalizeStrategy(input);
  const parts = [strategy.source === 'pokoin' ? 'Pokoin' : 'CardTrader'];
  if (strategy.basis === 'sold') parts.push('sold median (30 days)');
  else if (strategy.source === 'pokoin') parts.push('cheapest Pokoin ask');
  else parts.push(matchSummary(strategy.match));
  if (strategy.source !== 'pokoin') parts.push(strategy.feeExclusive ? 'net of CardTrader fees' : 'CardTrader ask');
  const flat = (sign) => (strategy.amountPkn > 0 ? ` ${sign} ${trimNumber(strategy.amountPkn)} PKN` : '');
  if (strategy.action === 'undercut') parts.push(`undercut ${trimNumber(strategy.amountPct)}%${flat('−')}`);
  else if (strategy.action === 'premium') parts.push(`+${trimNumber(strategy.amountPct)}%${flat('+')}`);
  else parts.push('match');
  const rounding = { integer: 'whole PKN', down: 'rounded down', up: 'rounded up' }[strategy.rounding];
  if (rounding) parts.push(rounding);
  if (strategy.minPkn > 0) parts.push(`min ${trimNumber(strategy.minPkn)} PKN`);
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
