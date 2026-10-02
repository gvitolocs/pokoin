'use strict';

/**
 * PIPELINE BLOCK: western-first popup cap (visual tie-break) + hard print filter
 * ---------------------------------------------------------
 * Slot: after attachExpansionNationality, before the JSON response.
 *
 * Does **not** change Meili ranking rules, `search_weight`, groupSuggestHits
 * name-intent, or search-page order. Meili `_rankingScore` stays as-is.
 *
 * Why: the popup is hard-capped at 20 rows. Among printings that already
 * share the same Meili points as a JP/CN row, show `nationality=western`
 * (European / EN-print) first — display order only. A western row with a
 * **lower** score never jumps a Japanese or Chinese row with a **higher**
 * score.
 *
 * When the print-language pill is japanese/chinese/western/korean, filter to
 * that bucket **before** the 20-cap so the chip is a hard universe constraint.
 * Empty nationality is `unknown`, never silently western.
 *
 * Revert (any one is enough):
 *   1. SUGGEST_PRINT_PRIORITY=0  (alias SUGGEST_WESTERN_FIRST=0)
 *   2. Delete the applySuggestPrintPriority() call in marketplace-suggest.js
 *   3. Delete this file
 *
 * Client still has filterSuggestByPrintLang as a safety net.
 */

const { capSuggestRows } = require('./_meili_suggest');
const {
  cleanPrintLanguage,
  effectivePrintBucket,
  printBucket,
  printLangMatchesBucket,
} = require('./_print_bucket');

const WESTERN_PRINTING_POOL = 96;

function suggestPrintPriorityEnabled() {
  const raw = String(
    process.env.SUGGEST_PRINT_PRIORITY ?? process.env.SUGGEST_WESTERN_FIRST ?? '1',
  ).trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function printingNationality(printing) {
  return String(printing?.nationality || '').trim().toLowerCase();
}

function isWesternPrinting(printing) {
  return effectivePrintBucket(printing) === 'western';
}

/** Bucket Meili `_rankingScore` so 0.87501 and 0.87502 count as the same points. */
function rankPoints(printing) {
  const rank = Number(printing?._rank);
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  return Math.round(rank * 1e4);
}

/**
 * Same Meili points → western before JP/CN. Different points → leave order.
 * Does not read or write `search_weight`.
 */
function preferWesternPrintings(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const indexed = (group.printings || []).map((printing, index) => ({ printing, index }));
    indexed.sort((left, right) => {
      const leftPoints = rankPoints(left.printing);
      const rightPoints = rankPoints(right.printing);
      if (leftPoints !== rightPoints) {
        return left.index - right.index;
      }
      const leftWestern = isWesternPrinting(left.printing) ? 0 : 1;
      const rightWestern = isWesternPrinting(right.printing) ? 0 : 1;
      return leftWestern - rightWestern || left.index - right.index;
    });
    return { ...group, printings: indexed.map((row) => row.printing) };
  });
}

function filterGroupsByPrintLanguage(groups, printLanguage, expansionLookup) {
  const bucket = cleanPrintLanguage(printLanguage);
  if (bucket === 'all') {
    return Array.isArray(groups) ? groups : [];
  }
  return (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      ...group,
      printings: (group.printings || []).filter(
        (printing) => printLangMatchesBucket(bucket, effectivePrintBucket(printing, expansionLookup)),
      ),
    }))
    .filter((group) => group.printings.length);
}

function publicPrinting(printing) {
  if (!printing || typeof printing !== 'object') {
    return printing;
  }
  const next = { ...printing };
  delete next._rank;
  delete next._meiliIndex;
  delete next._aliases;
  return next;
}

function publicGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group,
    printings: (group.printings || []).map(publicPrinting),
  }));
}

/**
 * @param {object[]} groups
 * @param {{ printLanguage?: string, maxRows?: number, enabled?: boolean, expansionLookup?: Function }} [options]
 */
function applySuggestPrintPriority(groups, options = {}) {
  const maxRows = Math.max(1, Number(options.maxRows) || 20);
  const list = Array.isArray(groups) ? groups : [];
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? Boolean(options.enabled)
    : suggestPrintPriorityEnabled();
  if (!enabled) {
    return publicGroups(capSuggestRows(list, maxRows));
  }
  const printLanguage = cleanPrintLanguage(options.printLanguage);
  let next = list;
  if (printLanguage !== 'all') {
    next = filterGroupsByPrintLanguage(next, printLanguage, options.expansionLookup);
  } else {
    next = preferWesternPrintings(next);
  }
  return publicGroups(capSuggestRows(next, maxRows));
}

module.exports = {
  WESTERN_PRINTING_POOL,
  suggestPrintPriorityEnabled,
  cleanPrintLanguage,
  isWesternPrinting,
  printBucket,
  effectivePrintBucket,
  rankPoints,
  preferWesternPrintings,
  filterGroupsByPrintLanguage,
  applySuggestPrintPriority,
};
