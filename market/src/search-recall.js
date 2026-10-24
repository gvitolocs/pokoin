import { fetchSearch } from './api.js';
import { compactQuery } from './compact-query.js';
import { isPokemonGame } from './game.js';
import { getSearchLang } from './locale.js';
import { createRecallSearch, recallOrder } from './search-recall-core.js';
import { loadSuggestEngine, peekSuggestEngine } from './suggest-engine-loader.js';

async function recallLookups(query, request = {}) {
  const raw = String(query || '').trim();
  const lang = request?.lang || getSearchLang();
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
    // Localized names recall their English identity (`evoli` → Eevee).
    await engine.loadLocalizedNames?.(lang);
    names = engine.catalogRecall(raw, { lang }) || [];
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
