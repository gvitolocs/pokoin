/**
 * The typeahead engine (ranker + 10k-name catalog + set/artist pools + resolver +
 * progressive pool) as ONE lazy chunk: the header loads it on search intent, not
 * with the first paint (suggest-engine-loader.js).
 */
export {
  cachedPrintings,
  isLiveStub,
  paintCatalogGroups,
  rememberPrintings,
  rememberSuggestGroups,
} from './suggest-live.js';
export { cardsWithCatalogArtist, catalogCacheKey, catalogIntent, groupsFromCards } from './suggest-catalog.js';
export { resolveSuggestQuery } from './suggest-resolve.js';
export { earlySetPrefixName } from './search-score.js';
export {
  buildScope,
  catalogRecall,
  chunkSize,
  createGenerationClock,
  emptyPool,
  reuseDecision,
  FIRST_CHUNK,
  MAX_CHUNKS,
  SAFETY_BUDGET,
} from './suggest-pool.js';
