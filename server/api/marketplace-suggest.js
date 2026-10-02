'use strict';

const { meiliConfigured } = require('./_meili_client');
const { meiliMarketplaceSuggestHits } = require('./_meili_marketplace');
const { useMeiliSearchForLanguage } = require('./_marketplace_search_engine');
const { groupSuggestHits, capSuggestRows, suggestMeiliHitLimit } = require('./_meili_suggest');
const { attachExpansionNationality } = require('./_expansion_nationality');
const { attachTitleLanguageOnGroups } = require('./_catalog_title_language');
const { catalogSqlNeeded } = require('./_suggest_catalog');

function loadTiming() {
  try {
    return require('../pokoin-api/_request_timing');
  } catch (_) {
    try {
      return require('./_request_timing');
    } catch (_) {
      return {
        beginRequest() { return null; },
        finishRequest() {},
        timed(_bucket, fn) { return fn(); },
      };
    }
  }
}
const { beginRequest, finishRequest, timed } = loadTiming();
const {
  applySuggestPrintPriority,
  WESTERN_PRINTING_POOL,
  cleanPrintLanguage,
} = require('./_suggest_western_priority');
const { rememberHotSuggestQuery } = require('./_suggest_hot_query');
const {
  parseGameFromRequest,
  runWithGame,
  isPokemonGame,
} = require('./_marketplace_game');
const { marketplaceQuery, marketplaceDatabaseUrl } = require('./_marketplace_db');
const { suggestMultigameGroups } = require('./_marketplace_multigame_sql');
const {
  setCorsHeaders,
  jsonOk,
  cleanText,
  parseLimit,
} = require('./_marketplace_react_card');

function emptySuggest(query, reason) {
  return {
    query,
    groups: [],
    count: 0,
    shown: 0,
    reason,
  };
}

function unpackSuggestHits(loaded) {
  if (Array.isArray(loaded)) {
    return {
      hits: loaded,
      estimatedTotalHits: loaded.length,
      printFilterApplied: false,
    };
  }
  const hits = Array.isArray(loaded?.hits) ? loaded.hits : [];
  return {
    hits,
    estimatedTotalHits: Number(loaded?.estimatedTotalHits || hits.length) || 0,
    printFilterApplied: loaded?.printFilterApplied === true,
  };
}

const SUGGEST_POPUP_ROWS = 20;

function createHandler(deps = {}) {
  const loadHits = deps.meiliMarketplaceSuggestHits || meiliMarketplaceSuggestHits;
  const configured = deps.meiliConfigured || meiliConfigured;
  const languageGate = deps.useMeiliSearchForLanguage || useMeiliSearchForLanguage;
  const loadMultigame = deps.suggestMultigameGroups || suggestMultigameGroups;
  const attachNationality = deps.attachExpansionNationality !== undefined
    ? deps.attachExpansionNationality
    : attachExpansionNationality;
  const applyPrintPriority = deps.applySuggestPrintPriority || applySuggestPrintPriority;
  const attachTitle = deps.attachTitleLanguageOnGroups !== undefined
    ? deps.attachTitleLanguageOnGroups
    : attachTitleLanguageOnGroups;
  const rememberHot = deps.rememberHotSuggestQuery || rememberHotSuggestQuery;
  const queryFn = deps.marketplaceQuery || marketplaceQuery;
  const databaseUrl = deps.marketplaceDatabaseUrl !== undefined
    ? deps.marketplaceDatabaseUrl
    : marketplaceDatabaseUrl;

  return async function handler(req, res) {
    const span = beginRequest('marketplace-suggest', req.method);
    if (typeof res.on === 'function') res.on('finish', () => finishRequest(span));
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const game = parseGameFromRequest(req);
    return runWithGame(game, async () => {
      const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
      const query = cleanText(url.searchParams.get('q') || url.searchParams.get('query'), 80);
      const searchLanguage = cleanText(
        url.searchParams.get('search_language')
          || url.searchParams.get('lang')
          || url.searchParams.get('language')
          || 'en',
        12,
      ) || 'en';
      // Web ranking hydrates a bounded candidate window before its own cap.
      // Existing clients still receive the ordinary twenty-row popup payload.
      const hydrate = url.searchParams.get('hydrate') === '1';
      const rowLimit = hydrate
        ? parseLimit(url.searchParams.get('limit'), 1000, 1000)
        : SUGGEST_POPUP_ROWS;
      const groupLimit = hydrate ? rowLimit
        : parseLimit(url.searchParams.get('limit'), SUGGEST_POPUP_ROWS, 24);
      const printLanguage = cleanPrintLanguage(
        url.searchParams.get('print_language')
          || url.searchParams.get('printLanguage')
          || 'all',
      );
      // `match=all` marks a corrected semantic lookup: every token must hit so
      // a resolver anchor cannot silently vanish. Default stays Meili "last".
      const matchingStrategy = url.searchParams.get('match') === 'all' ? 'all' : null;

      if (!query) {
        return jsonOk(res, { ...emptySuggest(query, 'empty_query'), game }, 'public, max-age=5, s-maxage=30');
      }

      if (!isPokemonGame()) {
        try {
          const groups = capSuggestRows(await loadMultigame(query, groupLimit), SUGGEST_POPUP_ROWS);
          const shown = groups.reduce((sum, group) => sum + group.printings.length, 0);
          return jsonOk(res, {
            query,
            game,
            groups,
            shown,
            count: shown,
          }, 'public, max-age=5, s-maxage=30, stale-while-revalidate=120');
        } catch (error) {
          console.error('marketplace-suggest multigame failed', error?.message || error);
          return jsonOk(
            res,
            { ...emptySuggest(query, 'sql_error'), game },
            'public, max-age=5, s-maxage=15',
          );
        }
      }

      if (!languageGate(searchLanguage) || !configured()) {
        return jsonOk(
          res,
          { ...emptySuggest(query, 'meili_unavailable'), game },
          'public, max-age=5, s-maxage=15',
        );
      }

      try {
        // A valid indexed facet can still be incomplete. Hydrate canonical
        // expansion nationality before filtering, rather than losing older
        // printings with a missing effective_print_bucket in Meili.
        const hitLimit = hydrate || printLanguage !== 'all'
          ? 1000 : suggestMeiliHitLimit(groupLimit);
        const loaded = unpackSuggestHits(
          await timed('meiliMs', () => loadHits(query, searchLanguage, hitLimit, {
            matchingStrategy,
            printLanguage: 'all',
          })),
        );
        const globalCount = Number(loaded.estimatedTotalHits) || 0;
        try {
          rememberHot(query, searchLanguage, loaded.hits, loaded.estimatedTotalHits, printLanguage);
        } catch (error) {
          console.error('marketplace-suggest hot query failed', error?.message || error);
        }
        // Wide printing pool first so equal-score western/JP printings can
        // tie-break before the 20-row cap. Cap happens in applySuggestPrintPriority.
        let groups = groupSuggestHits(
          loaded.hits,
          groupLimit,
          hydrate || printLanguage !== 'all' ? 1000 : WESTERN_PRINTING_POOL,
          query,
        );
        const catalog = catalogSqlNeeded(groups, searchLanguage);
        if (catalog.nationality && typeof attachNationality === 'function' && (deps.marketplaceQuery || databaseUrl())) {
          try {
            groups = await timed('sqlMs', () => attachNationality(groups, queryFn));
          } catch (error) {
            console.error('marketplace-suggest nationality failed', error?.message || error);
          }
        }
        if (catalog.title && typeof attachTitle === 'function' && (deps.marketplaceQuery || databaseUrl())) {
          try {
            groups = await timed('sqlMs', () => attachTitle(groups, searchLanguage, queryFn));
          } catch (error) {
            console.error('marketplace-suggest title language failed', error?.message || error);
          }
        }
        // Count matching printings in the retrieved pool before the 20-cap so
        // UI "View all N" is the filtered universe, not the popup size. When
        // Meili applied the print filter, estimatedTotalHits is authoritative.
        const { filterGroupsByPrintLanguage } = require('./_suggest_western_priority');
        const filteredPool = printLanguage === 'all'
          ? groups
          : filterGroupsByPrintLanguage(groups, printLanguage);
        const filteredPoolCount = filteredPool.reduce(
          (sum, group) => sum + (group.printings || []).length,
          0,
        );
        groups = applyPrintPriority(groups, {
          printLanguage,
          maxRows: rowLimit,
        });
        const shown = groups.reduce((sum, group) => sum + group.printings.length, 0);
        let count = shown;
        if (printLanguage === 'all') {
          count = Math.max(globalCount, shown);
        } else if (loaded.printFilterApplied) {
          count = Math.max(globalCount, shown);
        } else {
          // Pre-reindex fallback: Meili returned the global pool. Prefer the
          // filtered pool size when the retrieve was exhaustive relative to
          // the hit limit; never report the unfiltered Meili total.
          count = Math.max(filteredPoolCount, shown);
        }
        return jsonOk(res, {
          query,
          game,
          groups,
          shown,
          count,
          globalCount,
          printLanguage,
          hydrated: hydrate,
          candidateLimit: hitLimit,
          exhaustive: loaded.hits.length >= globalCount,
        }, 'public, max-age=5, s-maxage=30, stale-while-revalidate=120');
      } catch (error) {
        console.error('marketplace-suggest failed', error?.message || error);
        return jsonOk(
          res,
          { ...emptySuggest(query, 'meili_error'), game },
          'public, max-age=5, s-maxage=15',
        );
      }
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._test = { createHandler };
