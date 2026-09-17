/**
 * Suggest/search print-universe filter using the canonical effective bucket.
 * Kept separate from locale.js to avoid locale ↔ suggest-catalog ↔ suggest-rank cycles.
 */

import { effectivePrintBucket, printingMatchesPrintLang } from './print-bucket.js';
import { expansionNationality } from './suggest-catalog.js';

export function rowPrintBucket(row) {
  return effectivePrintBucket(row, expansionNationality);
}

export function filterSuggestByPrintLang(groups, printLang) {
  if (!printLang || printLang === 'all') {
    return groups;
  }
  return (groups || [])
    .map((group) => ({
      ...group,
      printings: (group.printings || []).filter((row) => (
        printingMatchesPrintLang(row, printLang, expansionNationality)
      )),
    }))
    .filter((group) => group.printings.length);
}
