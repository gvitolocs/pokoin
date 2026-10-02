'use strict';

const {
  rowsForVersions,
  canonicalPathForRow,
} = require('./marketplace-card-versions');
const { canonicalCardUrlForLookup } = require('./marketplace-card-url');
const {
  toReactCard,
  toReactCards,
  parsePublicCardId,
  parseLimit,
  setCorsHeaders,
  jsonOk,
  cleanText,
  withTimeout,
} = require('./_marketplace_react_card');
const { parseGameFromRequest, runWithGame } = require('./_marketplace_game');
const { visualThemeForShade } = require('./_card_visual_theme');
const sql = require('./_marketplace_react_sql');
const { beginRequest, finishRequest } = require('./_request_timing');
const { loadCardPage, beginFlight, cardPageKey } = require('./_read_model_cache');
const CARD_PAGE_CACHE = 'public, max-age=10, s-maxage=30, stale-while-revalidate=60';

function truthyFlag(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function titleForCard(card) {
  const parts = [card.name, card.set, card.number].filter(Boolean);
  return parts.length
    ? `${parts.join(' ')} Price & Cards for Sale | Pokoin`
    : 'Pokémon Cards for Sale | Pokoin';
}

async function safeCall(label, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.warn(`marketplace-card-page ${label} skipped`, error.message || error);
    return fallback;
  }
}

function createHandler(deps = {}) {
  const loadOffers = deps.readOffers || (async (cardId, limit, options) => {
    const listings = require('./marketplace-listings');
    if (typeof listings.readPublicOffersForCard === 'function') {
      return listings.readPublicOffersForCard(cardId, limit, options);
    }
    return [];
  });
  const loadCheapest = deps.readCheapestPrices || (async (input) => {
    const cheapest = require('./marketplace-card-cheapest-price');
    const read = cheapest.readCheapestPrices || cheapest._test.readCheapestPrices;
    return read(input);
  });
  const loadSales = deps.readSales || (async (input) => {
    const sales = require('./marketplace-card-sales');
    return sales.readCardSales(input);
  });
  const loadVersions = deps.rowsForVersions || rowsForVersions;
  const loadCanonical = deps.canonicalCardUrlForLookup || canonicalCardUrlForLookup;

  return async function handler(req, res) {
    const span = beginRequest('marketplace-card-page', req.method);
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
    let flight = null;
    try {
      const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
      const cardId = parsePublicCardId(
        url.searchParams.get('cardId') || url.searchParams.get('id'),
      );
      const lang = cleanText(
        url.searchParams.get('lang') ||
          url.searchParams.get('language') ||
          url.searchParams.get('search_language') ||
          'en',
        12,
      ) || 'en';
      const slug = cleanText(
        url.searchParams.get('cardSlug') || url.searchParams.get('slug'),
        240,
      );
      const includeSales = truthyFlag(url.searchParams.get('includeSales'));
      const includeOffers = truthyFlag(url.searchParams.get('includeOffers'));
      const includeSameAs = truthyFlag(url.searchParams.get('includeSameAs'));
      const liveOffers = truthyFlag(url.searchParams.get('liveOffers'));
      const offerLimit = parseLimit(url.searchParams.get('offerLimit'), 40, 80);
      const salesLimit = parseLimit(url.searchParams.get('salesLimit'), 40, 120);

      if (!cardId) {
        return res.status(400).json({ error: 'cardId is required (public marketplace id).' });
      }

      const cacheParts = {
        game,
        cardId,
        lang,
        includeOffers,
        includeSales,
        includeSameAs,
        liveOffers,
      };
      flight = beginFlight(cardPageKey(cacheParts));
      if (!flight.leader) {
        const shared = await flight.wait;
        if (shared) return jsonOk(res, shared, CARD_PAGE_CACHE);
      }
      const cachedPage = await loadCardPage(cacheParts, async () => null);
      if (cachedPage.source === 'valkey' && cachedPage.payload) {
        flight.finish(cachedPage.payload);
        return jsonOk(res, cachedPage.payload, CARD_PAGE_CACHE);
      }

      const loadCardRow = deps.readCardRow;
      const loadSetSiblings = deps.readSetSiblings;
      const loadNameSetSiblings = deps.readNameSetSiblings;
      const loadNeighbors = deps.readSetNeighbors;
      const loadVersionMeta = deps.readVersionSetMeta;
      const primaryRow = loadCardRow
        ? await loadCardRow({ cardId, cardSlug: slug, lang })
        : (await loadVersions({
          cardId,
          cardSlug: slug,
          limit: 8,
          searchLanguage: lang,
        }))[0];
      if (!primaryRow) {
        flight?.finish(null);
        return res.status(404).json({
          error: 'Card not found.',
          cardId,
        });
      }

      const card = toReactCard(primaryRow);
      const versionPromise = loadSetSiblings
        ? safeCall('versions', () => loadSetSiblings(primaryRow), [primaryRow])
        : (!loadCardRow
          ? loadVersions({
            cardId,
            cardSlug: slug,
            limit: 8,
            searchLanguage: lang,
          })
          : Promise.resolve([primaryRow]));

      const [canonical, versionRowsRaw, cheapestRows, offers, sales, sameAsRows, neighborPack, versionMeta, rarityRows] = await Promise.all([
        safeCall(
          'canonicalPath',
          () => loadCanonical({ cardId, language: lang }),
          null,
        ),
        versionPromise,
        withTimeout(
          () => safeCall('cheapest', () => loadCheapest({ cardId, language: lang }), []),
          800,
          [],
          'marketplace-card-page cheapest',
        ),
        includeOffers
          ? withTimeout(
            () => safeCall('offers', () => loadOffers(cardId, offerLimit, { nativeOnly: !liveOffers, game }), []),
            liveOffers ? 8000 : 800,
            [],
            'marketplace-card-page offers',
          )
          : Promise.resolve([]),
        includeSales
          ? withTimeout(
            () => safeCall('sales', () => loadSales({ cardId, limit: salesLimit }), []),
            2500,
            [],
            'marketplace-card-page sales',
          )
          : Promise.resolve([]),
        includeSameAs
          ? withTimeout(
            () => safeCall(
              'sameAs',
              () => loadVersions({
                sameAsCardId: cardId,
                limit: 24,
                productType: card.productType || 'card',
              }),
              [],
            ),
            2500,
            [],
            'marketplace-card-page sameAs',
          )
          : Promise.resolve([]),
        loadNeighbors
          ? withTimeout(
            () => safeCall('neighbors', () => loadNeighbors(primaryRow), { prev: [], next: [] }),
            800,
            { prev: [], next: [] },
            'marketplace-card-page neighbors',
          )
          : Promise.resolve({ prev: [], next: [] }),
        loadVersionMeta
          ? withTimeout(
            () => safeCall('versionSet', () => loadVersionMeta(cardId), null),
            400,
            null,
            'marketplace-card-page versionSet',
          )
          : Promise.resolve(null),
        loadNameSetSiblings
          ? withTimeout(
            () => safeCall('rarities', () => loadNameSetSiblings(primaryRow), []),
            400,
            [],
            'marketplace-card-page rarities',
          )
          : Promise.resolve([]),
      ]);

      const versionRows = Array.isArray(versionRowsRaw) && versionRowsRaw.length
        ? versionRowsRaw
        : [primaryRow];
      if (canonical && canonical.canonicalPath) {
        card.canonicalPath = canonical.canonicalPath;
        card.canonical_path = canonical.canonicalPath;
      } else if (!card.canonicalPath) {
        card.canonicalPath = canonicalPathForRow(primaryRow) || '';
        card.canonical_path = card.canonicalPath;
      }

      const cheapest = Array.isArray(cheapestRows) ? cheapestRows[0] || null : cheapestRows;
      if (cheapest && cheapest.pricePkn != null && card.price == null) {
        card.price = cheapest.pricePkn;
      }
      if (cheapest && cheapest.available) {
        card.isMarketAvailable = true;
        card.inStock = true;
        card.hasCardTraderListing = Boolean(cheapest.cardtrader && cheapest.cardtrader.available);
      }

      const sameAs = toReactCards(sameAsRows).filter((row) => row.id !== card.id);
      const versions = toReactCards(versionRows);
      const rarities = toReactCards(Array.isArray(rarityRows) ? rarityRows : []);
      const version = String(versionMeta?.version || card.version || '').trim();
      const versionCount = Number(versionMeta?.member_count) || versions.length;
      if (version) {
        card.version = version;
      }
      card.versionCount = versionCount;
      const packed = neighborPack && typeof neighborPack === 'object'
        ? neighborPack
        : { prev: [], next: [] };

      const payload = {
        card,
        game,
        version,
        visualTheme: primaryRow?.visual_theme || null,
        versions,
        rarities,
        versionCount,
        sameAs,
        neighbors: {
          prev: toReactCards(packed.prev),
          next: toReactCards(packed.next),
        },
        offers: Array.isArray(offers) ? offers : [],
        cheapest,
        sales: Array.isArray(sales) ? sales : [],
        artist: {
          name: card.artist || '',
          illustrator: card.illustrator || '',
        },
        canonicalPath: card.canonicalPath,
        seo: {
          title: titleForCard(card),
          description: [card.name, card.rarity, card.number, card.set]
            .filter(Boolean)
            .join(' · '),
          imageUrl: card.heroImageUrl || card.imageUrl,
          canonicalPath: card.canonicalPath,
        },
        lookup: {
          cardId,
          lang,
          slug,
        },
      };
      const stored = await loadCardPage(cacheParts, async () => payload);
      const body = stored?.payload || payload;
      flight?.finish(body);
      return jsonOk(res, body, CARD_PAGE_CACHE);
    } catch (error) {
      flight?.fail(error);
      console.error('marketplace-card-page failed', error);
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Marketplace card page failed.',
      });
    }
    });
  };
}

module.exports = createHandler({
  readCardRow: async ({ cardId }) => {
    const row = await sql.readCandidateByCardId(cardId);
    if (!row) {
      return null;
    }
    const [paths, cheapest, shadeRows, themes] = await Promise.all([
      sql.readCanonicalPaths([cardId]),
      sql.readCheapestMap([cardId], [row.ct_id]),
      sql.readArtShadeRows([row.ct_id]).catch(() => new Map()),
      sql.readVisualThemes([row.ct_id]).catch(() => new Map()),
    ]);
    const shadeRow = shadeRows.get(Number(row.ct_id)) || {};
    const artShade = String(shadeRow.shade || '');
    row.art_shade = artShade;
    // Visual theme rides in the same payload as card metadata so the desk
    // installs it before first paint. Validity is keyed on artwork_identity
    // (085): a persisted row is served only while the canonical leftover
    // JPEG is unchanged; stale/missing rows re-derive from the current
    // shade. No shade → null → the client keeps its neutral theme.
    row.visual_theme = visualThemeForShade(
      themes.get(Number(row.ct_id)),
      artShade,
      String(shadeRow.artwork_identity || ''),
    );
    return sql.applyCanonicalAndCheapest([row], paths, cheapest)[0];
  },
  readSetSiblings: async (row) => {
    const rows = await sql.readSetSiblings(row, 64);
    return sql.overlayCheapestOnRows(rows);
  },
  readNameSetSiblings: async (row) => {
    const rows = await sql.readNameSetSiblings(row, 24);
    return sql.overlayCheapestOnRows(rows);
  },
  readVersionSetMeta: (cardId) => sql.readVersionSetMeta(cardId),
  readSetNeighbors: async (row) => {
    const setName = String(row?.set_name || row?.set || row?.expansion_name || '').trim();
    const id = Number(row?.card_id || row?.id);
    if (!setName || !Number.isSafeInteger(id) || id <= 0) {
      return { prev: [], next: [] };
    }
    const packed = await sql.readSetNeighbors(setName, id, 6);
    const ids = [...packed.prev, ...packed.next].map((item) => item.card_id);
    const blueprints = [...packed.prev, ...packed.next].map((item) => item.ct_id);
    const [paths, cheapest] = await Promise.all([
      sql.readCanonicalPaths(ids),
      sql.readCheapestMap(ids, blueprints),
    ]);
    return {
      prev: sql.applyCanonicalAndCheapest(packed.prev, paths, cheapest),
      next: sql.applyCanonicalAndCheapest(packed.next, paths, cheapest),
    };
  },
  readCheapestPrices: async ({ cardId }) => {
    const cheapest = await sql.readCheapestMap([cardId], []);
    const hit = cheapest.byCardId.get(String(cardId));
    if (!hit) {
      return [];
    }
    return [{
      cardId: String(cardId),
      pricePkn: hit.price,
      available: true,
      cardtrader: { available: hit.hasCardTraderListing },
    }];
  },
  readOffers: async (cardId, limit, options) => {
    const listings = require('./marketplace-listings');
    if (typeof listings.readPublicOffersForCard === 'function') {
      return listings.readPublicOffersForCard(cardId, limit, options);
    }
    return [];
  },
});
module.exports.createHandler = createHandler;
module.exports._test = { createHandler, titleForCard, truthyFlag };
