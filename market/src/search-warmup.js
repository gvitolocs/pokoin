/**
 * Pre-warm marketplace search when language / print-family selectors change.
 *
 * Does not block the UI. Cancels obsolete warmups (latest-wins). Reuses the
 * progressive suggest + hot search-page clients so the first keystroke hits a
 * warm backend path for that universe.
 */

const WARM_SEED = 'p';
const WARM_TTL_MS = 45_000;

let controller = null;
let lastKey = '';
let lastAt = 0;
let generation = 0;

/** Canonical multi-select / filter key for cache families and dedupe. */
export function canonicalSearchUniverse({
  lang = 'en',
  printLang = 'all',
} = {}) {
  const language = String(lang || 'any').trim().toLowerCase() || 'any';
  const print = String(printLang || 'any').trim().toLowerCase() || 'any';
  const languages = language.split(/[+,]/).map((part) => part.trim()).filter(Boolean).sort();
  const prints = print.split(/[+,]/).map((part) => part.trim()).filter(Boolean).sort();
  return {
    lang: languages.join(',') || 'any',
    printLang: prints.join(',') || 'any',
    key: `lang:${languages.join(',') || 'any'}:print:${prints.join(',') || 'any'}`,
  };
}

export function redisSuggestWarmKey({ lang, printLang, query = WARM_SEED } = {}) {
  const universe = canonicalSearchUniverse({ lang, printLang });
  const q = String(query || '').trim().toLowerCase() || '_empty';
  return `pokoin:search:v1:suggest:${universe.key}:${q}`;
}

export function resetSearchWarmupForTests() {
  if (controller) controller.abort();
  controller = null;
  lastKey = '';
  lastAt = 0;
  generation = 0;
}

/**
 * Fire-and-forget warmup for the current (or provided) language + print family.
 * Pass `query` when the user already typed — refreshes that universe immediately.
 */
export async function warmupSearchUniverse({
  lang,
  printLang,
  query = '',
  fetchSearchPage,
  force = false,
} = {}) {
  const [
    { fetchSuggest },
    { isPokemonGame },
    locale,
    { prefetchSearchPage },
    { rememberSuggestGroups },
  ] = await Promise.all([
    import('./api.js'),
    import('./game.js'),
    import('./locale.js'),
    import('./search-hot.js'),
    import('./suggest-live.js'),
  ]);
  const resolvedLang = lang || locale.getSearchLang();
  const resolvedPrint = printLang || locale.getPrintLang();
  if (!isPokemonGame()) return null;

  const universe = canonicalSearchUniverse({ lang: resolvedLang, printLang: resolvedPrint });
  const typed = String(query || '').trim();
  const warmQuery = typed.length >= 1 ? typed : WARM_SEED;
  const dedupeKey = `${universe.key}\0${warmQuery.toLowerCase()}`;
  const now = Date.now();
  if (!force && dedupeKey === lastKey && now - lastAt < WARM_TTL_MS && controller) {
    return null;
  }
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  const gen = (generation += 1);
  lastKey = dedupeKey;
  lastAt = now;

  const requestLang = universe.lang === 'any' ? 'en' : universe.lang.split(',')[0];
  const requestPrint = universe.printLang === 'any' || universe.printLang === 'all'
    ? 'all'
    : universe.printLang.split(',')[0];

  const suggest = fetchSuggest(warmQuery, {
    limit: typed ? 20 : 12,
    offset: 0,
    progressive: true,
    hydrate: true,
    signal,
    lang: requestLang,
    printLang: requestPrint,
  }).then((page) => {
    if (gen !== generation) return null;
    rememberSuggestGroups(page?.groups, { searchLang: requestLang });
    return page;
  }).catch((error) => {
    if (error?.name === 'AbortError') return null;
    return null;
  });

  const search = typed.length >= 2 && typeof fetchSearchPage === 'function'
    ? prefetchSearchPage(typed, requestLang, {
      fetchSearchPage,
      signal,
      printLang: requestPrint,
    }).catch(() => null)
    : Promise.resolve(null);

  const [page] = await Promise.all([suggest, search]);
  return page;
}
