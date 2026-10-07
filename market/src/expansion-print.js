/**
 * Exact-name pins for expansions the catalog still marks unknown.
 * Product buckets stay flagless. Do not regex set titles.
 */

const PINS = new Map([
  ['30th celebration premium deck set', 'japanese'],
  ['30th-celebration-premium-deck-set', 'japanese'],
  ['aura seeker', 'japanese'],
  ['aura-seeker', 'japanese'],
  ['mega x mega parade', 'japanese'],
  ['mega-x-mega-parade', 'japanese'],
  ['csv9.5: master ball reverse', 'chinese'],
  ['csv9-5-master-ball-reverse', 'chinese'],
]);

export function pinnedExpansionNationality(row = {}) {
  const name = String(row.name || row.set || row.set_name || row.expansion || row.expansion_name || '')
    .trim()
    .toLowerCase();
  const slug = String(row.slug || '').trim().toLowerCase();
  return PINS.get(name) || PINS.get(slug) || '';
}

/** Keep a real catalog nationality. Fill only empty / unknown. */
export function resolveExpansionNationality(row = {}) {
  const existing = String(row.nationality || '').trim().toLowerCase();
  if (existing && existing !== 'unknown') {
    return existing;
  }
  return pinnedExpansionNationality(row) || '';
}
