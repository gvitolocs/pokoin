import { createSignal, untrack } from 'solid-js';
import { fetchSearch } from '@market/api.js';
import { isPokemonGame } from '@market/game.js';
import { prefetchSearchPage } from '@market/search-hot.js';
import { normalizeSearchTab } from '@market/search-kind.js';
import { printLang, searchLang } from '../stores/locale.js';
import { peekEntryData } from './scroll-restore.js';

/**
 * Eager half of the search route (router.js): the query parser and the
 * resolver load beside the route chunk, and the first results page is
 * requested before that chunk arrives. Both modules are shared with the
 * header's typeahead engine, so after typing they resolve from memory.
 */
const [rankModule, setRankModule] = createSignal(null);
const [resolveModule, setResolveModule] = createSignal(null);
let rankPromise = null;
let resolvePromise = null;

/** Query parser stub when the chunk fails: every query reads as plain text. */
const PLAIN_TEXT = {
  parseTypedQuery: (raw) => ({ raw, nameQuery: raw, setTokens: [], artTokens: [], numberTokens: [], rarityTokens: [], eras: [] }),
  isSetAwareQuery: () => false,
  isSetOnlyQuery: () => false,
  isNumberAwareQuery: () => false,
  printingMatchesNumberFilter: () => true,
  fetchSetAwareCards: async () => [],
};

/** suggest-rank.js (parseTypedQuery, set-aware fetch, collector filter). */
export function loadSearchRank() {
  rankPromise ||= import('@market/suggest-rank.js').then(
    (module) => {
      setRankModule(() => module);
      return module;
    },
    () => {
      setRankModule(() => PLAIN_TEXT);
      return PLAIN_TEXT;
    },
  );
  return rankPromise;
}

/** suggest-resolve.js, only for `resolved=` links (typeahead set/artist chips). */
export function loadSearchResolve() {
  resolvePromise ||= import('@market/suggest-resolve.js').then(
    (module) => {
      setResolveModule(() => module);
      return module;
    },
    () => {
      const none = { resolveSuggestQuery: () => null, parseResolutionParam: () => ({ names: [], artists: [], sets: [], free: [] }) };
      setResolveModule(() => none);
      return none;
    },
  );
  return resolvePromise;
}

export { rankModule, resolveModule };

/** The `/marketplace/search` URL as the page reads it (React Search.jsx). */
export function searchRequest(search) {
  const params = new URLSearchParams(search || '');
  const tab = normalizeSearchTab(params.get('tab'));
  return {
    query: (params.get('q') || params.get('query') || '').trim(),
    tab,
    resolved: (params.get('resolved') || '').trim(),
    printLang: !isPokemonGame() || tab === 'users' ? 'all' : untrack(printLang),
    lang: untrack(searchLang),
  };
}

/**
 * Route preload: navigation, back/forward, initial render and link intent.
 * The header already prefetched this page before navigating (same cache key),
 * so prefetchSearchPage returns its promise instead of asking again; a back
 * arrival with an in-memory snapshot asks nothing at all.
 */
export function preloadSearch({ location }) {
  const req = searchRequest(location?.search);
  if (req.tab === 'users') return;
  loadSearchRank();
  if (req.resolved) loadSearchResolve();
  if (req.query.length < 2) return;
  if (peekEntryData(`${location.pathname}${location.search}`)) return;
  prefetchSearchPage(req.query, req.lang, {
    fetchSearchPage: fetchSearch,
    tab: req.tab,
    printLang: req.printLang,
  }).catch(() => {});
}
