/**
 * Pure logic of the MyPokoin Pricer UI (pricing groups, strategies, board
 * selection). The pricing rules themselves live in `@market/pricer.js`.
 */
// Relative, not @market: node --test loads this module without Vite's alias.
import {
  DEFAULT_STRATEGY,
  effectiveMatch,
  matchKey,
  normalizeStrategy,
  PRICER_MATCHES,
  PRICER_SOURCES,
  pricerBases,
  sourceSwitches,
  strategyComp,
  strategyExample,
} from '../../../../market/src/pricer.js';

/** The board's "No group" filter value (a group id is never this). */
export const NO_GROUP = '__none';

/**
 * The comp the strategy editor's example uses when the seller has none
 * loaded: CardTrader ask 28 / net 25.56 for the exact copy, cheaper as the
 * toggles loosen, for every toggle combination (`ctMatch` keys), plus a
 * `sources` block with a number for every source, basis and toggle
 * combination the sources honour (Cardmarket in EUR, TCGplayer in USD at
 * $1.08/€, converted to PKN).
 */
export const SAMPLE_COMP = (() => {
  const ctMatch = {};
  for (let bits = 0; bits < 16; bits += 1) {
    const match = Object.fromEntries(PRICER_MATCHES.map(({ id }, index) => [id, Boolean(bits & (1 << index))]));
    const on = Object.values(match).filter(Boolean).length;
    const ask = 28 - (4 - on) * 1.5;
    ctMatch[matchKey(match)] = { grossPkn: ask, pkn: Math.round(ask * 0.913 * 100) / 100 };
  }
  const pknEntry = (pkn) => ({ grossPkn: pkn, pkn });
  const eurPkn = (eur) => Math.round(eur * 200 * 100) / 100;
  const usdPkn = (usd) => Math.round(((usd * 200) / 1.08) * 100) / 100;
  // CardTrader sold: every toggle combination, looser is cheaper.
  const ctSold = {};
  for (let bits = 0; bits < 16; bits += 1) {
    const match = Object.fromEntries(PRICER_MATCHES.map(({ id }, index) => [id, Boolean(bits & (1 << index))]));
    const on = Object.values(match).filter(Boolean).length;
    const gross = Math.round((26.1 - (4 - on) * 1.2) * 100) / 100;
    ctSold[matchKey(match)] = { grossPkn: gross, pkn: Math.round(gross * 0.913 * 100) / 100 };
  }
  // Pokoin's own sales honour condition and language.
  const pokoinSold = { '': pknEntry(28), C: pknEntry(30), L: pknEntry(30), CL: pknEntry(31) };
  // Cardmarket's price guide honours finish; prices are EUR (2 PKN = 1 cent).
  const cardmarket = { asOf: '2026-11-07' };
  for (const [basis, [plain, foil]] of Object.entries({
    trend: [0.12, 0.15], low: [0.1, 0.13], avg1: [0.14, 0.18], avg7: [0.16, 0.2], avg30: [0.17, 0.22],
  })) {
    cardmarket[basis] = {
      '': { eur: plain, grossPkn: eurPkn(plain), pkn: eurPkn(plain) },
      F: { eur: foil, grossPkn: eurPkn(foil), pkn: eurPkn(foil) },
    };
  }
  // TCGplayer honours finish and 1st edition; prices are USD at the day's ECB rate.
  const tcgplayer = { asOf: '2026-11-07', rateDay: '2026-11-07', usdPerEur: 1.08 };
  const tcgKeys = ['', 'F', 'E', 'FE'];
  for (const [basis, usds] of Object.entries({
    market: [0.25, 0.28, 0.27, 0.3], low: [0.2, 0.22, 0.21, 0.24], mid: [0.26, 0.29, 0.28, 0.32],
  })) {
    tcgplayer[basis] = {};
    usds.forEach((usd, index) => {
      tcgplayer[basis][tcgKeys[index]] = { usd, grossPkn: usdPkn(usd), pkn: usdPkn(usd) };
    });
  }
  return {
    ctMatch,
    soldMedianPkn: 24.5,
    soldMedianGrossPkn: 26.1,
    pokoinCheapestPkn: 27,
    sources: { cardtrader: { sold: ctSold }, pokoin: { sold: pokoinSold }, cardmarket, tcgplayer },
  };
})();

const idOf = (row) => String(row?.id ?? row ?? '');

/** `set` with `id` flipped. */
export function toggleSelected(set, id) {
  const next = new Set(set);
  const key = idOf(id);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** `set` with every id of `rows` added (`on`) or removed. */
export function selectRows(set, rows, on) {
  const next = new Set(set);
  for (const row of rows || []) {
    const key = idOf(row);
    if (!key) continue;
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** 'all' | 'some' | 'none' of `rows` in `set` (the page checkbox). */
export function selectionState(set, rows) {
  let hit = 0;
  let total = 0;
  for (const row of rows || []) {
    const key = idOf(row);
    if (!key) continue;
    total += 1;
    if (set.has(key)) hit += 1;
  }
  if (!total || !hit) return 'none';
  return hit === total ? 'all' : 'some';
}

/** Every filtered row is already selected: "Select all M filtered" has nothing to add. */
export function allSelected(set, rows) {
  return (rows || []).every((row) => set.has(idOf(row)));
}

/**
 * The board's Group filter: '' any group, NO_GROUP listings in no group,
 * otherwise that group's listings. `memberships` is `membershipMap(...)`.
 */
export function groupFilter(filter, memberships) {
  if (!filter) return () => true;
  if (filter === NO_GROUP) return (row) => !memberships.has(idOf(row));
  return (row) => memberships.get(idOf(row)) === filter;
}

/**
 * What moving `ids` into `targetId` does: how many come from no group, how
 * many already sit there, and how many leave each other group.
 */
export function movePlan(ids, memberships, targetId) {
  const from = new Map();
  let fresh = 0;
  let already = 0;
  for (const raw of ids || []) {
    const current = memberships.get(idOf(raw));
    if (!current) fresh += 1;
    else if (current === targetId) already += 1;
    else from.set(current, (from.get(current) || 0) + 1);
  }
  return { fresh, already, from: [...from].map(([groupId, count]) => ({ groupId, count })) };
}

const cards = (count) => `${count} ${count === 1 ? 'card' : 'cards'}`;

/** The result line after moving cards into a group. */
export function moveResultLine(plan, groups, targetName) {
  const nameOf = (id) => (groups || []).find((group) => group.id === id)?.name || 'another group';
  const moved = plan.fresh + plan.from.reduce((sum, entry) => sum + entry.count, 0);
  const parts = [`Added ${cards(moved)} to ${targetName}`];
  const notes = plan.from.map((entry) => `${entry.count} moved from ${nameOf(entry.groupId)}`);
  if (plan.already) notes.push(`${plan.already} already there`);
  return notes.length ? `${parts[0]} (${notes.join(', ')}).` : `${parts[0]}.`;
}

/** The result line after taking cards out of their group. */
export function removeResultLine(removed) {
  const count = Number(removed) || 0;
  return count ? `Took ${cards(count)} out of their group.` : 'None of those cards were in a group.';
}

/** "<name> copy", then "<name> copy 2", … until no strategy has that name (ignoring case). */
export function uniqueCopyName(name, others) {
  const taken = new Set((others || []).map((other) => String(other?.name || '').trim().toLowerCase()));
  const base = `${String(name || '').trim() || 'Strategy'} copy`.slice(0, 74);
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * The comp of the strategy editor's worked example: the first of `comps`
 * (the selected group's cards) with the strategy's source in its `sources`
 * block, else the first with a CardTrader offer per toggle combination
 * (`ctMatch`), else SAMPLE_COMP.
 */
export function pickExampleComp(comps, input) {
  const source = normalizeStrategy(input).source;
  const list = comps || [];
  return list.find((comp) => comp?.sources && typeof comp.sources === 'object' && comp.sources[source])
    || list.find((comp) => comp?.ctMatch && typeof comp.ctMatch === 'object')
    || SAMPLE_COMP;
}

/**
 * The CardTrader ask beside a strategy's comp: the offer of its toggles
 * (`ctMatch`). Null for every other source and basis — only CardTrader
 * offers have an ask beside the net.
 */
export function askFor(comp, input) {
  const strategy = normalizeStrategy(input);
  if (strategy.source !== 'cardtrader' || strategy.basis !== 'offers') return null;
  const key = matchKey(strategy.match);
  if (comp?.ctMatch && typeof comp.ctMatch === 'object') return positive(comp.ctMatch[key]?.grossPkn);
  return key === 'CLFE' ? positive(comp?.ctMatchedGrossPkn) : key === '' ? positive(comp?.ctCheapestGrossPkn) : null;
}

const num = (value) => String(Math.round(value * 100) / 100);

/** What the example says when the comp has no offer for the strategy's toggles. */
export const NO_OFFER = 'No offer like that for this card right now';

/**
 * The worked example on one comp as steps: `{ steps: [text], target,
 * noOffer }`, e.g. "CardTrader ask 28", "you net 25.56", "−5% 24.28",
 * "nearest", target 24; "Cardmarket trend €0.15 = 30 PKN"; "TCGplayer
 * market $0.30 = 55.56 PKN at $1.08/€". It follows the strategy's toggles:
 * no number for them is `noOffer`, never a guess.
 */
export function exampleSteps(input, comp = SAMPLE_COMP) {
  const strategy = normalizeStrategy(input);
  const steps = [];
  const value = strategyComp(comp, strategy);
  const { source, basis } = strategy;
  if (source === 'pokoin') {
    if (value != null) steps.push(`Pokoin ${basis === 'sold' ? 'sold median' : 'ask'} ${num(value)}`);
  } else if (source === 'cardmarket' || source === 'tcgplayer') {
    if (value != null) {
      const label = PRICER_SOURCES.find((entry) => entry.id === source)?.label || source;
      // "Cardmarket 7-day average", "TCGplayer market price": the basis as the editor names it.
      const named = `${label} ${(pricerBases(source).find((entry) => entry.id === basis)?.label || basis).toLowerCase()}`;
      const entry = comp?.sources?.[source]?.[basis]?.[matchKey(effectiveMatch(strategy))];
      if (source === 'cardmarket') {
        const eur = entry?.eur != null ? `€${Number(entry.eur).toFixed(2)}` : null;
        steps.push(eur ? `${named} ${eur} = ${num(value)} PKN` : `${named} ${num(value)} PKN`);
      } else {
        const usd = entry?.usd != null ? `$${Number(entry.usd).toFixed(2)}` : null;
        const rate = comp?.sources?.tcgplayer?.usdPerEur;
        const at = rate != null ? ` at $${num(rate)}/€` : '';
        steps.push(usd ? `${named} ${usd} = ${num(value)} PKN${at}` : `${named} ${num(value)} PKN`);
      }
    }
  } else {
    const ask = askFor(comp, strategy) ?? value;
    if (value != null) {
      steps.push(`CardTrader ${basis === 'sold' ? 'sold median' : 'ask'} ${num(ask)}`);
      if (strategy.feeExclusive && value !== ask) steps.push(`you net ${num(value)}`);
    }
  }
  if (value == null) return { steps, target: null, noOffer: true };
  const example = strategyExample(value, strategy);
  if (!example) return { steps, target: null, noOffer: false };
  const flat = strategy.amountPkn > 0 ? ` ${num(strategy.amountPkn)} PKN` : '';
  if (strategy.action === 'undercut') steps.push(`−${num(strategy.amountPct)}%${flat ? ` −${flat}` : ''} ${num(example.adjusted)}`);
  else if (strategy.action === 'premium') steps.push(`+${num(strategy.amountPct)}%${flat ? ` +${flat}` : ''} ${num(example.adjusted)}`);
  const rounding = { integer: 'nearest', down: 'round down', up: 'round up' }[strategy.rounding];
  if (rounding) steps.push(rounding);
  if (example.target != null && strategy.minPkn > 0 && example.target === strategy.minPkn && example.adjusted < strategy.minPkn) {
    steps.push(`never below ${num(strategy.minPkn)}`);
  }
  return { steps, target: example.target, noOffer: false };
}

/**
 * The example's steps as one line ending where the target goes: a rounding
 * or floor step reads into the target ("… → nearest 24 PKN").
 */
export function exampleLead(steps) {
  const list = steps || [];
  const last = list[list.length - 1] || '';
  const joined = list.join(' → ');
  return /^(nearest|round|never)/.test(last) ? `${joined} ` : `${joined} → `;
}

/** "Used by A, B" from a strategy's `groupNames`. */
export function usedByLine(groupNames) {
  const names = (groupNames || []).filter(Boolean);
  return names.length ? `Used by ${names.join(', ')}` : 'Not used by any group';
}

/** PKN amounts in the Pricer: digits only, at most two decimals (D000014). */
export function pkn(value) {
  const number = Math.round((Number(value) || 0) * 100) / 100;
  return `${Number.isInteger(number) ? number : number.toFixed(2)} PKN`;
}

/** Plan entries whose price moves, and those that go on sale. */
export function planCounts(plan) {
  let prices = 0;
  let onSale = 0;
  for (const entry of plan || []) {
    if (Math.abs((Number(entry.target) || 0) - (Number(entry.current) || 0)) >= 0.01) prices += 1;
    if (entry.activate) onSale += 1;
  }
  return { prices, onSale };
}

/** The Apply button's label. */
export function applyLabel(plan) {
  const { prices, onSale } = planCounts(plan);
  const head = `Apply ${prices} ${prices === 1 ? 'price' : 'prices'}`;
  return onSale ? `${head} · put ${onSale} on sale` : head;
}

/** A group's listings whose price does not change, after the plan's. */
export function unchangedMembers(rows, memberships, groupId, plan) {
  const planned = new Set((plan || []).map((entry) => String(entry.listingId)));
  return (rows || []).filter((row) => memberships.get(idOf(row)) === groupId && !planned.has(idOf(row)));
}

/**
 * The market column of a card whose price does not change: its comp under
 * the group's strategy and the CardTrader ask beside it, as plan entries
 * carry them (`planReprice`), or nulls without a comp.
 */
export function unchangedMarket(comp, strategy) {
  const compPkn = strategy ? strategyComp(comp, strategy) : null;
  return { compPkn, askPkn: compPkn == null ? null : askFor(comp, strategy) };
}

/** The line after an apply. */
export function appliedLine(answer) {
  const applied = Number(answer?.applied) || 0;
  const activated = Number(answer?.activated) || 0;
  const failed = (answer?.failed || []).length;
  const parts = [`Applied ${applied} ${applied === 1 ? 'price' : 'prices'}`];
  if (activated) parts.push(`put ${activated} on sale`);
  if (failed) parts.push(`${failed} failed`);
  return `${parts.join(' · ')}.`;
}

const SWITCH_CHIP = { condition: 'Condition', language: 'Language', finish: 'Finish', firstEdition: '1st ed.' };
const ROUNDING_CHIP = { integer: 'whole PKN', down: 'round down', up: 'round up' };

/**
 * What a strategy tile in the pricer pop-up shows (Pokoin and Card Rails
 * draw the same tile from it): `icon` the action ('match' "=", 'undercut'
 * arrow down, 'premium' arrow up), `source` the source's label, `basis` the
 * basis's label, `sold` for a sold-median strategy (calendar), `rules` the
 * rule chips ('net of fees' / 'CardTrader ask' only for CardTrader,
 * 'USD → EUR' for TCGplayer), and `switches` the toggles the source honours:
 * "All exact" when every honoured toggle is on, else the on ones, else
 * "Any copy"; Pokoin's cheapest ask is always "Cheapest Pokoin ask"
 * (`allExact` styles "All exact").
 */
export function strategyTile(input) {
  const strategy = normalizeStrategy(input);
  const pct = num(strategy.amountPct);
  const flat = num(strategy.amountPkn);
  const rules = [];
  if (strategy.action === 'undercut') {
    rules.push([strategy.amountPct > 0 ? `−${pct}%` : '', strategy.amountPkn > 0 ? `− ${flat} PKN` : ''].filter(Boolean).join(' ') || 'Undercut');
  } else if (strategy.action === 'premium') {
    rules.push([strategy.amountPct > 0 ? `+${pct}%` : '', strategy.amountPkn > 0 ? `+ ${flat} PKN` : ''].filter(Boolean).join(' ') || 'Above');
  } else {
    rules.push('Match');
  }
  if (ROUNDING_CHIP[strategy.rounding]) rules.push(ROUNDING_CHIP[strategy.rounding]);
  if (strategy.minPkn > 0) rules.push(`min ${num(strategy.minPkn)}`);
  if (strategy.source === 'cardtrader') rules.push(strategy.feeExclusive ? 'net of fees' : 'CardTrader ask');
  if (strategy.source === 'tcgplayer') rules.push('USD → EUR');
  const sold = strategy.basis === 'sold';
  const can = sourceSwitches(strategy.source, strategy.basis);
  const eff = effectiveMatch(strategy);
  const honoured = PRICER_MATCHES.filter(({ id }) => can[id]);
  const allExact = honoured.length > 0 && honoured.every(({ id }) => eff[id] === true);
  let switches;
  if (strategy.source === 'pokoin' && strategy.basis === 'offers') {
    switches = ['Cheapest Pokoin ask'];
  } else if (allExact) {
    switches = ['All exact'];
  } else {
    switches = honoured.filter(({ id }) => eff[id]).map(({ id }) => SWITCH_CHIP[id]);
    if (!switches.length) switches = ['Any copy'];
  }
  return {
    icon: strategy.action,
    source: PRICER_SOURCES.find((entry) => entry.id === strategy.source)?.label || strategy.source,
    basis: pricerBases(strategy.source).find((entry) => entry.id === strategy.basis)?.label || strategy.basis,
    sold,
    rules,
    switches,
    allExact,
  };
}

/**
 * A strategy as the editor opens it: every field as the server reads it
 * (`normalizeStrategy`: a saved `match`, else the old basis — 'cheapest'
 * all off, 'matched' or none all on), the name as typed. No strategy: the
 * new-strategy form (`DEFAULT_STRATEGY`).
 */
export function strategyDraft(strategy) {
  const source = strategy || { ...DEFAULT_STRATEGY, match: { ...DEFAULT_STRATEGY.match } };
  return { ...normalizeStrategy(source), name: String(source.name || '') };
}

const comparable = (draft) => {
  const { id: _id, ...rest } = normalizeStrategy(draft);
  return JSON.stringify(rest);
};

/** The draft differs from what it was opened as (any field, the switches included). */
export function draftChanged(draft, saved) {
  return comparable(draft) !== comparable(saved);
}

/**
 * A source change in the editor: the basis stays when the new source has it,
 * else the new source's default (its first basis). The toggles (`match`)
 * are never rewritten.
 */
export function withSource(draft, source) {
  const bases = pricerBases(source);
  const basis = bases.some((entry) => entry.id === draft?.basis) ? draft.basis : bases[0].id;
  return { ...(draft || {}), source, basis };
}

/** The editor shows the toggles for every source and basis but Pokoin's cheapest ask. */
export function showsSwitches(draft) {
  return !(draft?.source === 'pokoin' && draft?.basis === 'offers');
}
