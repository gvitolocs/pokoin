import NATIONALITY from './data/expansion-nationality.js';
import { compactQuery } from './compact-query.js';

/**
 * Expansion title → print nationality (western / japanese / …) from the set
 * catalog. Same keys as suggest-catalog SET_POOL (compact display, last row
 * wins), but without importing the name ranker, so print filters and api.js
 * stay light. The table is derived from suggest-sets.js by
 * scripts/export-expansion-nationality.mjs (17 KB instead of 83 KB).
 */
let byCompact = null;

function table() {
  if (!byCompact) {
    byCompact = new Map();
    for (const [nationality, compacts] of Object.entries(NATIONALITY)) {
      for (const compact of compacts.split(' ')) {
        if (compact) byCompact.set(compact, nationality);
      }
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
