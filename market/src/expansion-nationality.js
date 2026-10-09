import RAW_SETS from './data/suggest-sets.js';
import { compactQuery } from './compact-query.js';

/**
 * Expansion title → print nationality (western / japanese / …) from the set
 * catalog. Same keys as suggest-catalog SET_POOL (compact display, last row
 * wins), but without importing the name ranker, so print filters and api.js
 * stay light.
 */
let byCompact = null;

function table() {
  if (!byCompact) {
    byCompact = new Map();
    for (const row of RAW_SETS) {
      byCompact.set(
        compactQuery(String(row.display || '').trim()),
        String(row.nationality || '').trim().toLowerCase(),
      );
    }
  }
  return byCompact;
}

export function expansionNationality(setName) {
  const compact = compactQuery(setName);
  if (!compact) {
    return '';
  }
  return table().get(compact) || '';
}
