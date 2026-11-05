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

/**
 * A row's own pricing choice, as the server keeps it (`clean_row_pricing`):
 * `{ groupId }`, `{ strategyId }`, `{ none: true }` (stay unpriced), or null
 * (the batch's).
 */
export function rowOwnPricing(row) {
  const raw = row?.pricing;
  if (!raw || typeof raw !== 'object') return raw === 'none' ? { none: true } : null;
  if (raw.none === true) return { none: true };
  const group = String(raw.groupId || '').trim();
  if (group) return { groupId: group };
  const strategy = String(raw.strategyId || '').trim();
  return strategy ? { strategyId: strategy } : null;
}

/** What prices a row at submit (`row_pricing`): its own choice, else the batch's; null for none. */
export function effectiveRowPricing(row, defaults) {
  const own = rowOwnPricing(row);
  if (own?.none) return null;
  if (own) return own;
  const value = pricingChoiceValue(defaults);
  if (value.startsWith('group:')) return { groupId: value.slice(6) };
  if (value.startsWith('strategy:')) return { strategyId: value.slice(9) };
  return null;
}

/** An unpriced row is priced at submit (no "Needs a price"). */
export function rowIsPriced(row, defaults) {
  return effectiveRowPricing(row, defaults) != null;
}

/**
 * The row's pricing chip: `{ label, kind }` with kind 'own' (the row's own
 * choice, highlighted), 'batch' (the batch default, greyed) or 'none'.
 */
export function rowPricingChip(row, defaults, data) {
  const own = rowOwnPricing(row);
  if (own?.none) return { label: 'None', kind: 'none' };
  const choice = own || effectiveRowPricing(row, defaults);
  const kind = own ? 'own' : 'batch';
  if (!choice) return { label: 'No pricing', kind };
  const strategies = Array.isArray(data?.strategies) ? data.strategies : [];
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const name = choice.groupId
    ? groups.find((g) => String(g.id) === choice.groupId)?.name || 'Group not found'
    : strategies.find((s) => String(s.id) === choice.strategyId)?.name || 'Strategy not found';
  return { label: name, kind };
}

/**
 * The item patch for a choice in the pricer pop-up's row mode: `{ kind:
 * 'batch' }` → null (the batch's), 'none' → `{ none: true }`, 'group' /
 * 'strategy' with `id`.
 */
export function rowPricingPatch(choice) {
  if (choice?.kind === 'none') return { none: true };
  if (choice?.kind === 'group' && choice.id) return { groupId: String(choice.id) };
  if (choice?.kind === 'strategy' && choice.id) return { strategyId: String(choice.id) };
  return null;
}

/**
 * The `applyPricing` calls after a submit: one per group with every created
 * listing that joined it, one per strategy with its rows that had no price
 * (`rowPricing`); an older answer without `rowPricing` prices the batch's
 * choice over every created listing.
 */
export function pricingApplyBodies(result) {
  const rows = Array.isArray(result?.rowPricing) ? result.rowPricing : null;
  if (rows) {
    const groups = new Map();
    const strategies = new Map();
    for (const entry of rows) {
      const listingId = entry?.listingId;
      if (!listingId) continue;
      if (entry.groupId) {
        groups.set(entry.groupId, [...(groups.get(entry.groupId) || []), listingId]);
      } else if (entry.strategyId && entry.priced === false) {
        strategies.set(entry.strategyId, [...(strategies.get(entry.strategyId) || []), listingId]);
      }
    }
    return [
      ...[...groups].map(([groupId, listingIds]) => ({ groupId, listingIds })),
      ...[...strategies].map(([strategyId, listingIds]) => ({ strategyId, listingIds })),
    ];
  }
  const pricing = result?.pricing;
  if (!pricing || (!pricing.groupId && !pricing.strategyId)) return [];
  const listingIds = (Array.isArray(result?.created) ? result.created : [])
    .map((entry) => entry?.listingId)
    .filter(Boolean);
  if (!listingIds.length) return [];
  return [pricing.groupId ? { groupId: pricing.groupId, listingIds } : { strategyId: pricing.strategyId, listingIds }];
}

/** The answers of several `applyPricing` calls as one. */
export function sumPricingAnswers(answers) {
  const sum = { applied: 0, activated: 0, noComp: 0, failed: [] };
  for (const out of answers || []) {
    sum.applied += Number(out?.applied) || 0;
    sum.activated += Number(out?.activated) || 0;
    sum.noComp += Number(out?.noComp) || 0;
    if (Array.isArray(out?.failed)) sum.failed.push(...out.failed);
  }
  return sum;
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

/** The line when `applyPricing` failed for some calls: the submit stands. */
export function pricingFailedLine(bodies) {
  const list = Array.isArray(bodies) ? bodies : [bodies];
  const inGroup = list.some((body) => body?.groupId);
  const where = inGroup ? 'Cards in a group stay there' : 'Unpriced cards are paused';
  return `Pricing failed for ${plural(list.length, 'choice', 'choices')}. ${where} and can be priced from the Pricer tab.`;
}
