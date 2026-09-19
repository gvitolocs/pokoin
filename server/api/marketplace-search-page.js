'use strict';

const { rowsForCards, productFacetRows } = require('./marketplace-cards');
const {
  toReactCards,
  parseLimit,
  parseOffset,
  setCorsHeaders,
  jsonOk,
  cleanText,
} = require('./_marketplace_react_card');
const {
  parseGameFromRequest,
  runWithGame,
  isPokemonGame,
} = require('./_marketplace_game');
const { rowsForMultigameCards } = require('./_marketplace_multigame_sql');
const sql = require('./_marketplace_react_sql');
const { attachTitleLanguageOnRows } = require('./_catalog_title_language');
const { marketplaceQuery, marketplaceDatabaseUrl } = require('./_marketplace_db');
const { cleanPrintLanguage } = require('./_print_bucket');

function createHandler(deps = {}) {
  const loadCards = deps.rowsForCards || rowsForCards;
  const loadFacets = deps.productFacetRows || productFacetRows;
  const loadMultigame = deps.rowsForMultigameCards || rowsForMultigameCards;
  const overlayCheapest = deps.overlayCheapestOnRows || sql.overlayCheapestOnRows;
  const overlayTitle = deps.attachTitleLanguageOnRows !== undefined
    ? deps.attachTitleLanguageOnRows
    : attachTitleLanguageOnRows;
  const queryFn = deps.marketplaceQuery || marketplaceQuery;
  const databaseUrl = deps.marketplaceDatabaseUrl !== undefined
    ? deps.marketplaceDatabaseUrl
    : marketplaceDatabaseUrl;

  return async function handler(req, res) {
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
      try {
        const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
        const query = cleanText(
          url.searchParams.get('query') || url.searchParams.get('q'),
          180,
        );
        const productType = cleanText(url.searchParams.get('productType'), 60);
        const productSearchOnly = url.searchParams.get('productSearchOnly') === '1';
        const searchLanguage = cleanText(
          url.searchParams.get('search_language') ||
            url.searchParams.get('lang') ||
            url.searchParams.get('language') ||
            'en',
          12,
        ) || 'en';
        const limit = parseLimit(url.searchParams.get('limit'), 100, 100);
        const offset = parseOffset(url.searchParams.get('offset'));
        const includeFacets = url.searchParams.get('includeFacets') !== '0';
        const printLanguage = cleanPrintLanguage(
          url.searchParams.get('print_language')
            || url.searchParams.get('printLanguage')
            || 'all',
        );

        let rows;
        let facets = [];
        let queryTotal = null;
        if (!isPokemonGame()) {
          rows = await loadMultigame({
            query,
            limit: limit + 1,
            offset,
            productType,
            productSearchOnly,
          });
        } else {
          const [loaded, facetRows] = await Promise.all([
            loadCards({
              query,
              limit: limit + 1,
              offset,
              productType,
              productSearchOnly,
              searchLanguage,
              printLanguage,
              lightHydrate: true,
              withTotal: true,
            }),
            includeFacets
              ? loadFacets({ query, searchLanguage }).catch(() => [])
              : Promise.resolve([]),
          ]);
          // withTotal contract: { rows, total } — total answers the SAME
          // predicate as rows. Bare arrays (older deps / multigame) carry no
          // total and the field stays null so the UI never invents a number.
          rows = Array.isArray(loaded)
            ? loaded
            : (Array.isArray(loaded?.rows) ? loaded.rows : []);
          queryTotal = !Array.isArray(loaded) && loaded && loaded.total != null
            ? (Number(loaded.total) || null)
            : null;
          facets = Array.isArray(facetRows) ? facetRows : [];
        }
        const hasMore = Array.isArray(rows) && rows.length > limit;
        const page = (Array.isArray(rows) ? rows : []).slice(0, limit);
        const priced = await overlayCheapest(page);
        let titled = priced;
        if (typeof overlayTitle === 'function' && (deps.marketplaceQuery || databaseUrl())) {
          try {
            titled = await overlayTitle(priced, searchLanguage, queryFn);
          } catch (error) {
            console.error('marketplace-search-page title language failed', error?.message || error);
          }
        }
        const cards = toReactCards(titled);

        return jsonOk(res, {
          query,
          game,
          productType,
          productSearchOnly,
          lang: searchLanguage,
          limit,
          offset,
          count: cards.length,
          total: queryTotal,
          hasMore,
          cards,
          facets: {
            products: Array.isArray(facets) ? facets : [],
          },
        }, 'public, max-age=15, s-maxage=60, stale-while-revalidate=120');
      } catch (error) {
        console.error('marketplace-search-page failed', error);
        return res.status(error.statusCode || 500).json({
          error: error.message || 'Marketplace search page failed.',
        });
      }
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._test = { createHandler };
