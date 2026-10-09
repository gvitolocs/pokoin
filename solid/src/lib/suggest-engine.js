/**
 * The typeahead engine — ranker, 10k-name catalog, set/artist pools, resolver,
 * progressive pool — as ONE lazy chunk. SearchBox imports it on input focus
 * or when the page goes idle, never with the first paint. Nothing here starts
 * rank workers: the header ranks on the main thread (paintCatalogGroups), and
 * ScanDesk spawns its workers on demand.
 */
export {
  cachedPrintings,
  isLiveStub,
  paintCatalogGroups,
  rememberPrintings,
  rememberSuggestGroups,
  suggestLiveReady,
} from '@market/suggest-live.js';
export { cardsWithCatalogArtist, catalogCacheKey, catalogIntent, groupsFromCards } from '@market/suggest-catalog.js';
export { resolveSuggestQuery } from '@market/suggest-resolve.js';
export { earlySetPrefixName } from '@market/search-score.js';
export {
  buildScope,
  catalogRecall,
  chunkSize,
  createGenerationClock,
  emptyPool,
  reuseDecision,
  MAX_CHUNKS,
  SAFETY_BUDGET,
} from '@market/suggest-pool.js';
