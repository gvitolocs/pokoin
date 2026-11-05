/**
 * The pricing server's answers, computed on fixture state for the MyPokoin
 * layout preview (`?mypokoinPreview`), which has no backend. Same shapes as
 * `@market/api.js` (fetchPricingStrategies, savePricingGroup, applyPricing…).
 * State: `{ strategies, groups, pairs }`, `pairs` as `[[listingId, groupId]]`.
 */
// Relative, not @market: node --test loads this module without Vite's alias.
import { nameProblem, normalizeStrategy, planReprice, strategySummary } from '../../../../market/src/pricer.js';
import { priceCheckKey } from '../../../../market/src/inventory-price.js';
import { askFor } from './pricer-ui.js';

const str = (value) => String(value ?? '');

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  error.status = code ? 409 : 400;
  throw error;
}

/** Groups with `listingCount` from the pairs. */
export function countGroups(groups, pairs) {
  const counts = new Map();
  for (const [, groupId] of pairs) counts.set(groupId, (counts.get(groupId) || 0) + 1);
  return groups.map((group) => ({ ...group, listingCount: counts.get(group.id) || 0 }));
}

/** Strategies with the server's `summary` and `groupNames`. */
export function decorateStrategies(strategies, groups) {
  return strategies.map((strategy) => ({
    ...strategy,
    summary: strategySummary(strategy),
    groupNames: groups.filter((group) => group.strategyId === strategy.id).map((group) => group.name),
  }));
}

/** What `fetchPricingStrategies` + `fetchPricingGroups` answer for `state`. */
export function snapshot(state) {
  const groups = countGroups(state.groups, state.pairs);
  return {
    strategies: decorateStrategies(state.strategies, groups),
    groups,
    memberships: state.pairs.map((pair) => [...pair]),
  };
}

let sequence = 0;
const newId = (kind) => {
  sequence += 1;
  return `preview-${kind}-${Date.now().toString(36)}-${sequence}`;
};

/** `{ strategy }`: create or edit. Answers `{ state, savedId }`. */
export function saveStrategy(state, input) {
  const strategy = normalizeStrategy(input);
  const problem = nameProblem(strategy.name, strategy.id, state.strategies, 'strategy');
  if (problem) fail(problem);
  const id = strategy.id || newId('strategy');
  const saved = { ...strategy, id };
  const exists = state.strategies.some((entry) => entry.id === id);
  const strategies = exists ? state.strategies.map((entry) => (entry.id === id ? saved : entry)) : [...state.strategies, saved];
  return { state: { ...state, strategies }, savedId: id };
}

/** Refuses a strategy a group still uses (server: 409 `strategy_in_use`). */
export function deleteStrategy(state, id) {
  const users = state.groups.filter((group) => group.strategyId === id).map((group) => group.name);
  if (users.length) fail(`This strategy prices ${users.join(', ')}. Give those groups another strategy first.`, 'strategy_in_use');
  return { ...state, strategies: state.strategies.filter((entry) => entry.id !== id) };
}

/** Moves `ids` into `groupId`, out of any other group. */
function addTo(pairs, groupId, ids) {
  const moving = new Set((ids || []).map(str));
  const kept = pairs.filter(([listingId]) => !moving.has(listingId));
  const added = [...moving].filter((listingId) => !pairs.some(([id, group]) => id === listingId && group === groupId)).length;
  return { pairs: [...kept, ...[...moving].map((listingId) => [listingId, groupId])], added };
}

/**
 * `savePricingGroup` on local state: `{ group, add? }`, `{ groupId, add }`
 * or `{ remove }`. Answers `{ state, groupId, added, removed }`.
 */
export function saveGroup(state, body) {
  let { groups, pairs } = state;
  let groupId = str(body?.groupId);
  let added = 0;
  let removed = 0;
  if (body?.group) {
    const input = body.group;
    const name = str(input.name).trim().slice(0, 80);
    const problem = nameProblem(name, input.id || '', groups, 'group');
    if (problem) fail(problem);
    if (!state.strategies.some((entry) => entry.id === input.strategyId)) fail('Pick a strategy for the group.');
    groupId = str(input.id) || newId('group');
    const existing = groups.find((group) => group.id === groupId);
    const saved = {
      lastAppliedAt: null,
      lastApplied: null,
      ...existing,
      id: groupId,
      name,
      strategyId: input.strategyId,
      autoDaily: input.autoDaily === true,
    };
    groups = existing ? groups.map((group) => (group.id === groupId ? saved : group)) : [...groups, saved];
  }
  if (body?.add?.length) {
    if (!groups.some((group) => group.id === groupId)) fail('That group no longer exists.');
    ({ pairs, added } = addTo(pairs, groupId, body.add));
  }
  if (body?.remove?.length) {
    const leaving = new Set(body.remove.map(str));
    const before = pairs.length;
    pairs = pairs.filter(([listingId]) => !leaving.has(listingId));
    removed = before - pairs.length;
  }
  return { state: { ...state, groups, pairs }, groupId, added, removed };
}

/** Deletes a group; its listings keep their prices and leave the group. */
export function deleteGroup(state, id) {
  return {
    ...state,
    groups: state.groups.filter((group) => group.id !== id),
    pairs: state.pairs.filter(([, groupId]) => groupId !== id),
  };
}

/** A row's price-check entry from `comps` keyed like the board's price check. */
export function compLookup(comps) {
  return (row) => comps?.[priceCheckKey(row)] || comps?.[str(row?.cardId || row?.card_id)] || null;
}

/**
 * `applyPricing({ groupId, dryRun })` on fixture rows and price-check
 * answers (`comps` keyed like the board's price check). Answers the server's
 * shape, plus `state` (lastApplied stamped) and `rows` (repriced) unless dry.
 */
export function applyGroup(state, rows, comps, { groupId, dryRun }, now = new Date()) {
  const group = state.groups.find((entry) => entry.id === groupId);
  if (!group) fail('That group no longer exists.');
  const strategy = state.strategies.find((entry) => entry.id === group.strategyId);
  if (!strategy) fail('The group has no strategy.');
  const members = new Set(state.pairs.filter(([, id]) => id === groupId).map(([listingId]) => listingId));
  const scopedRows = (rows || []).filter((row) => members.has(str(row?.id)));
  const compFor = compLookup(comps);
  // planReprice prices with strategyComp, so the plan follows the strategy's toggles.
  const result = planReprice(scopedRows, compFor, strategy);
  const plan = result.plan.map((entry) => ({
    listingId: str(entry.row.id),
    cardName: entry.row.cardName || entry.row.name || '',
    setName: entry.row.setName || entry.row.set_name || '',
    collectorNumber: entry.row.collectorNumber || entry.row.collector_number || '',
    condition: entry.row.condition || '',
    language: entry.row.language || '',
    status: str(entry.row.status || 'active').toLowerCase(),
    current: entry.current,
    compPkn: entry.compPkn,
    // The ask of the offer the toggles picked, not always the exact copy's.
    askPkn: askFor(compFor(entry.row), strategy),
    target: entry.target,
    activate: entry.activate,
  }));
  const activated = plan.filter((entry) => entry.activate).length;
  const answer = {
    plan,
    scoped: result.scoped,
    noComp: result.noComp,
    unchanged: result.unchanged,
    activated: dryRun ? 0 : activated,
    applied: dryRun ? 0 : plan.length,
    failed: [],
    dryRun: Boolean(dryRun),
  };
  if (dryRun) return answer;
  const byId = new Map(plan.map((entry) => [entry.listingId, entry]));
  const nextRows = (rows || []).map((row) => {
    const entry = byId.get(str(row?.id));
    if (!entry) return row;
    return { ...row, pricePkn: entry.target, ...(entry.activate ? { status: 'active' } : {}) };
  });
  const changed = plan.filter((entry) => Math.abs(entry.target - entry.current) >= 0.01).length;
  const groups = state.groups.map((entry) => (entry.id === groupId
    ? {
      ...entry,
      lastAppliedAt: now.toISOString(),
      lastApplied: { changed, activated, noComp: result.noComp, unchanged: result.unchanged, failed: 0, trigger: 'manual' },
    }
    : entry));
  return { ...answer, state: { ...state, groups }, rows: nextRows };
}
