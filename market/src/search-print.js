/**
 * Search-page print chip.
 *
 * GET /api/marketplace-search-page?print_language=western (and japanese /
 * chinese) returns an empty book: hydrated rows have blank nationality, and
 * the API treats unknown as not-in-bucket. The search bar already classified
 * those same printings. The page asks for the unfiltered window and keeps
 * the chip here, using the expansion nationality the suggest popup uses.
 */

import { printLangMatchesBucket } from './print-bucket.js';
import { rowPrintBucket } from './print-filter.js';

export function cardsForPrint(cards, printLang) {
  const want = String(printLang || 'all').trim().toLowerCase();
  if (!want || want === 'all') {
    return cards || [];
  }
  return (cards || []).filter((card) => printLangMatchesBucket(want, rowPrintBucket(card)));
}

/**
 * Walk unfiltered search pages until this print has a card or the window ends.
 * A first page of only the other prints must not paint "No matches".
 */
export async function loadSearchPrintPage({
  fetchPage,
  printLang,
  offset = 0,
  maxPages = 4,
}) {
  let cursor = Math.max(0, Number(offset) || 0);
  let kept = [];
  let hasMore = false;
  let pages = 0;
  const cap = Math.max(1, Number(maxPages) || 1);
  while (pages < cap) {
    const data = await fetchPage(cursor);
    const raw = data?.cards || [];
    cursor += raw.length;
    kept = kept.concat(cardsForPrint(raw, printLang));
    hasMore = Boolean(data?.hasMore) && raw.length > 0;
    pages += 1;
    if (kept.length || !hasMore) {
      break;
    }
  }
  return { cards: kept, hasMore, nextOffset: cursor };
}
