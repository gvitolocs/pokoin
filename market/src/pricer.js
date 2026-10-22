/**
 * The MyPokoin pricer: one pricing strategy (users/{uid}.pricingStrategies,
 * `pokoin_external::pricing` on the server) applied to listings from their
 * market comps (`GET /api/marketplace-price-check`). Pure functions shared by
 * the Pricer dialog on the listings board and Settings → Pricing strategies.
 *
 * A strategy:
 *   source        'cardtrader' | 'pokoin'
 *   basis         'matched'  same card, condition, language and finish (CardTrader:
 *                            the professional floor for Pokémon, the cheapest Zero
 *                            copy in this condition or better for the other games)
 *                 'cheapest' the cheapest copy of the card, any facet
 *                 'sold'     the 30-day sold median
 *   feeExclusive  true: what a seller nets on CardTrader after its commission
 *                 (`ctMatchedPkn`, docs/PRICING.md); false: the CardTrader ask itself
 *   action        'match' | 'undercut' | 'premium', by amountPct % and amountPkn PKN
 *   rounding      'none' | 'integer' (nearest) | 'down' | 'up'  (whole PKN)
 *   minPkn        never price below this (after rounding)
 *   scope         game, status ('' | 'active' | 'paused'), condition, language
 *   activatePaused  a paused listing that gets a price goes on sale
 */

export const PRICER_SOURCES = [
  { id: 'cardtrader', label: 'CardTrader' },
  { id: 'pokoin', label: 'Pokoin' },
];

export const PRICER_BASES = [
  { id: 'matched', label: 'Same card and facets', hint: 'Same condition, language and finish. CardTrader: the professional floor (Pokémon) or the cheapest Zero copy in this condition or better.' },
  { id: 'cheapest', label: 'Cheapest copy', hint: 'The cheapest copy of the card in any condition, language or finish.' },
  { id: 'sold', label: 'Sold median (30 days)', hint: 'The median CardTrader sale of the last 30 days.' },
];

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

export const PRICER_STATUSES = [
  { id: '', label: 'Live and paused' },
  { id: 'active', label: 'Live only' },
  { id: 'paused', label: 'Paused only' },
];

export const DEFAULT_PRICER = {
  id: '',
  name: '',
  source: 'cardtrader',
  basis: 'matched',
  feeExclusive: true,
  action: 'match',
  amountPct: 0,
  amountPkn: 0,
  rounding: 'integer',
  minPkn: 1,
  game: '',
  status: '',
  condition: '',
  language: '',
  activatePaused: true,
  enabled: true,
};

const pick = (value, list, fallback) => (list.some((entry) => entry.id === value) ? value : fallback);
const finite = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

/** A stored or edited strategy with every field present and in range. */
export function normalizePricer(input = {}) {
  const raw = { ...DEFAULT_PRICER, ...(input || {}) };
  return {
    ...raw,
    source: pick(raw.source, PRICER_SOURCES, 'cardtrader'),
    basis: pick(raw.basis, PRICER_BASES, 'matched'),
    feeExclusive: raw.feeExclusive !== false,
    action: pick(raw.action, PRICER_ACTIONS, 'match'),
    amountPct: finite(raw.amountPct, 0, 0, 90),
    amountPkn: finite(raw.amountPkn, 0, 0, 1_000_000),
    rounding: pick(raw.rounding, PRICER_ROUNDINGS, 'none'),
    minPkn: finite(raw.minPkn, 0, 0, 1_000_000),
    game: String(raw.game || '').trim().toLowerCase(),
    status: pick(raw.status, PRICER_STATUSES, ''),
    condition: String(raw.condition || '').toUpperCase(),
    language: String(raw.language || '').toUpperCase(),
    activatePaused: raw.activatePaused === true,
    enabled: raw.enabled !== false,
  };
}

function positive(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The market number a strategy starts from, in PKN, or null. CardTrader
 * numbers are fee-exclusive unless the strategy asks for the ask itself
 * (`…GrossPkn`, sent by the server since 2026-10-21; an older answer only
 * has the net, which is then used either way).
 */
export function pricerComp(comp, input) {
  if (!comp) return null;
  const strategy = normalizePricer(input);
  const choose = (net, gross) => (strategy.feeExclusive ? positive(net) : positive(gross) ?? positive(net));
  if (strategy.source === 'pokoin') {
    if (strategy.basis === 'sold') return choose(comp.soldMedianPkn, comp.soldMedianGrossPkn);
    return positive(comp.pokoinCheapestPkn) ?? choose(comp.soldMedianPkn, comp.soldMedianGrossPkn);
  }
  if (strategy.basis === 'cheapest') return choose(comp.ctCheapestPkn, comp.ctCheapestGrossPkn);
  if (strategy.basis === 'sold') return choose(comp.soldMedianPkn, comp.soldMedianGrossPkn);
  return choose(comp.ctMatchedPkn, comp.ctMatchedGrossPkn);
}

/**
 * The new price for a comp: undercut or premium, rounding, then the floor
 * (the floor always wins, so rounding never takes a price under it). The
 * server's `pricing::evaluate_strategy_target` and the Verus proof
 * (`floor_price`) state the same rule.
 */
export function pricerTarget(compPkn, input) {
  const comp = positive(compPkn);
  if (comp == null) return null;
  const strategy = normalizePricer(input);
  let target = comp;
  if (strategy.action === 'undercut') target = target * (1 - strategy.amountPct / 100) - strategy.amountPkn;
  else if (strategy.action === 'premium') target = target * (1 + strategy.amountPct / 100) + strategy.amountPkn;
  if (strategy.rounding === 'integer') target = Math.round(target);
  else if (strategy.rounding === 'down') target = Math.floor(target + 1e-9);
  else if (strategy.rounding === 'up') target = Math.ceil(target - 1e-9);
  if (strategy.minPkn > 0) target = Math.max(target, strategy.minPkn);
  if (!(target > 0)) return null;
  return Math.round(target * 100) / 100;
}

const rowGame = (row, fallback) => String(row?.marketplaceGame || row?.marketplace_game || fallback || 'pokemon').toLowerCase();
const rowStatus = (row) => String(row?.status || 'active').toLowerCase();

/** Does a strategy's scope take this listing? */
export function pricerMatches(input, row, fallbackGame = 'pokemon') {
  const strategy = normalizePricer(input);
  if (!strategy.enabled) return false;
  if (strategy.game && rowGame(row, fallbackGame) !== strategy.game) return false;
  const status = rowStatus(row);
  if (status !== 'active' && status !== 'paused') return false;
  if (strategy.status && status !== strategy.status) return false;
  if (strategy.condition && String(row?.condition || 'NM').toUpperCase() !== strategy.condition) return false;
  if (strategy.language && String(row?.language || '').toUpperCase() !== strategy.language) return false;
  return true;
}

/**
 * The reprice plan: one entry per listing whose price moves (or that goes on
 * sale), with the comp it came from. `compFor(row)` returns the row's price
 * check entry. Listings without a comp are counted, never guessed.
 */
export function planReprice(rows, compFor, input, fallbackGame = 'pokemon') {
  const strategy = normalizePricer(input);
  const plan = [];
  let scoped = 0;
  let noComp = 0;
  let unchanged = 0;
  for (const row of rows || []) {
    if (!pricerMatches(strategy, row, fallbackGame)) continue;
    scoped += 1;
    const comp = compFor(row);
    const compPkn = pricerComp(comp, strategy);
    const target = pricerTarget(compPkn, strategy);
    if (target == null) {
      noComp += 1;
      continue;
    }
    const current = Number(row?.pricePkn ?? row?.price_pkn ?? 0) || 0;
    const activate = strategy.activatePaused && rowStatus(row) === 'paused';
    if (Math.abs(target - current) < 0.01 && !activate) {
      unchanged += 1;
      continue;
    }
    plan.push({
      row,
      current,
      compPkn,
      askPkn: positive(comp?.ctMatchedGrossPkn),
      target,
      activate,
    });
  }
  return { plan, scoped, noComp, unchanged };
}

/** The listing update one plan entry sends. */
export function planUpdate(entry) {
  return entry.activate ? { pricePkn: entry.target, status: 'active' } : { pricePkn: entry.target };
}

/** One line describing a strategy, for lists and the dialog title. */
export function pricerSummary(input) {
  const strategy = normalizePricer(input);
  const parts = [PRICER_SOURCES.find((entry) => entry.id === strategy.source)?.label || strategy.source];
  parts.push(PRICER_BASES.find((entry) => entry.id === strategy.basis)?.label.toLowerCase() || strategy.basis);
  if (strategy.source === 'cardtrader') parts.push(strategy.feeExclusive ? 'net of CardTrader fees' : 'CardTrader ask');
  if (strategy.action === 'match') parts.push('match');
  if (strategy.action === 'undercut') parts.push(`undercut ${strategy.amountPct}%${strategy.amountPkn ? ` − ${strategy.amountPkn} PKN` : ''}`);
  if (strategy.action === 'premium') parts.push(`+${strategy.amountPct}%${strategy.amountPkn ? ` + ${strategy.amountPkn} PKN` : ''}`);
  const rounding = { integer: 'whole PKN', down: 'rounded down', up: 'rounded up' }[strategy.rounding];
  if (rounding) parts.push(rounding);
  if (strategy.minPkn) parts.push(`min ${strategy.minPkn} PKN`);
  if (strategy.game) parts.push(strategy.game);
  if (strategy.status) parts.push(strategy.status === 'paused' ? 'paused only' : 'live only');
  if (strategy.condition) parts.push(strategy.condition);
  if (strategy.language) parts.push(strategy.language);
  return parts.join(' · ');
}
