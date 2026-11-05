/**
 * Batch pricing on the Scan desk: the batch defaults name a pricing group
 * (`pricingGroupId`) or a strategy (`pricingStrategyId`), at most one. On
 * submit, unpriced rows are listed paused at 0 and the desk prices the
 * created listings once with `applyPricing` (docs/SCAN_CONNECT.md, "Batch
 * pricing").
 */

/** The select value for the batch defaults: `group:<id>`, `strategy:<id>` or "". */
export function pricingChoiceValue(defaults) {
  const group = String(defaults?.pricingGroupId || '');
  if (group) return `group:${group}`;
  const strategy = String(defaults?.pricingStrategyId || '');
  return strategy ? `strategy:${strategy}` : '';
}

/** The defaults patch for a select value; always sends both keys. */
export function pricingChoicePatch(value) {
  const text = String(value || '');
  if (text.startsWith('group:')) return { pricingGroupId: text.slice(6), pricingStrategyId: '' };
  if (text.startsWith('strategy:')) return { pricingGroupId: '', pricingStrategyId: text.slice(9) };
  return { pricingGroupId: '', pricingStrategyId: '' };
}

/** Whether the batch defaults name a group or a strategy. */
export function batchHasPricing(defaults) {
  return pricingChoiceValue(defaults) !== '';
}

/**
 * Select options from `fetchPricingStrategies`: groups as "<name> · <strategy
 * name>", then strategies. A saved choice that is no longer in the list stays
 * selectable so the select shows what the batch holds.
 */
export function pricingOptions(data, defaults) {
  const strategies = Array.isArray(data?.strategies) ? data.strategies : [];
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const strategyName = new Map(strategies.map((s) => [String(s.id), String(s.name || 'Strategy')]));
  const groupOptions = groups.map((g) => ({
    value: `group:${g.id}`,
    label: `${g.name || 'Group'} · ${strategyName.get(String(g.strategyId)) || 'no strategy'}`,
  }));
  const strategyOptions = strategies.map((s) => ({ value: `strategy:${s.id}`, label: String(s.name || 'Strategy') }));
  const current = pricingChoiceValue(defaults);
  if (current.startsWith('group:') && !groupOptions.some((o) => o.value === current)) {
    groupOptions.push({ value: current, label: 'Group not found' });
  }
  if (current.startsWith('strategy:') && !strategyOptions.some((o) => o.value === current)) {
    strategyOptions.push({ value: current, label: 'Strategy not found' });
  }
  return { groups: groupOptions, strategies: strategyOptions };
}

/** The line under the select. */
export function pricingHint(defaults) {
  const value = pricingChoiceValue(defaults);
  if (!value) return '';
  const base = "Unpriced cards get the strategy's price when the batch loads and go on sale. Cards with no market price stay paused";
  return value.startsWith('group:') ? `${base} in the group.` : `${base}.`;
}

/** `applyPricing` body for a submit result, or null when there is nothing to price. */
export function pricingApplyBody(result) {
  const pricing = result?.pricing;
  if (!pricing || (!pricing.groupId && !pricing.strategyId)) return null;
  const listingIds = (Array.isArray(result?.created) ? result.created : [])
    .map((entry) => entry?.listingId)
    .filter(Boolean);
  if (!listingIds.length) return null;
  return pricing.groupId ? { groupId: pricing.groupId, listingIds } : { strategyId: pricing.strategyId, listingIds };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One line for the `applyPricing` answer. */
export function pricingResultLine(out) {
  const applied = Number(out?.applied) || 0;
  const activated = Number(out?.activated) || 0;
  const noComp = Number(out?.noComp) || 0;
  const failed = Array.isArray(out?.failed) ? out.failed.length : Number(out?.failed) || 0;
  const parts = [
    `Priced ${plural(applied, 'card', 'cards')}`,
    `${activated} put on sale`,
    `${noComp} ${noComp === 1 ? 'has' : 'have'} no market price`,
  ];
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/** The line when `applyPricing` failed: the submit stands. */
export function pricingFailedLine(body) {
  const where = body?.groupId ? 'They are in the group' : 'Unpriced cards are paused';
  return `Pricing failed. ${where} and can be priced from the Pricer tab.`;
}
