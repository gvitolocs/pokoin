import { fetchSearch } from './api.js';
import { compactQuery } from './compact-query.js';
import { isPokemonGame } from './game.js';
import { createRecallSearch, recallOrder } from './search-recall-core.js';
import { loadSuggestEngine, peekSuggestEngine } from './suggest-engine-loader.js';

async function recallLookups(query) {
  const raw = String(query || '').trim();
  let engine = peekSuggestEngine();
  if (!engine) {
    try {
      engine = await loadSuggestEngine();
    } catch {
      return [raw];
    }
  }
  let names = [];
  try {
    names = engine.catalogRecall(raw) || [];
  } catch {
    names = [];
  }
  return recallOrder(raw, names, compactQuery);
}

/**
 * fetchSearch for the Singles tab, over the same recall lookups the header
 * popup counts (search-recall-core.js). Product / Users and satellite games
 * fall through to the plain search page.
 */
export const fetchSearchRecall = createRecallSearch({
  fetchSearchPage: fetchSearch,
  recallLookups,
  isRecallRequest: (request) => isPokemonGame()
    && request.productType === 'card'
    && !request.productSearchOnly
    && String(request.query || '').trim().length >= 2,
});
