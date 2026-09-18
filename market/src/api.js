import { exactNameQuery, filterExactNameRows } from './exact-name.js';
import { attachRecentsToHome, fetchCardTiles, fetchExpansionFromLists, fetchHomeFromLists, fetchSetIndexFromLists, isPublicRailsVector } from './lists.js';
import { applyLastMedianPrices, applyTilePrice, formatPkn, formatPknNumber, idsMissingTilePrice, lastMedianFromSales, tilePricePkn } from './pkn.js';
export { formatPkn, formatPknNumber };
import { readRecentCardIds, rememberCardId, peekRecentTile } from './recents.js';
import { framedByChromeExtension, publicApiUrl } from './extension-auth-bridge.js';
import { withGameQuery, isPokemonGame, gameRequestHeaders, game } from './game.js';
import { sanitizeCardName, vintedSearchUrl } from './identity.js';
import { publicIdFromScanHit, scanCatalogId } from './scan-id.js';
import { getSearchLang } from './locale.js';
import { artistSlug } from './artist-name.js';
import { rememberSuggestGroups } from './suggest-live.js';
import { expansionNationality } from './suggest-catalog.js';
import { collectPrintingThumbUrls, preloadSuggestThumbs } from './suggest-images.js';
import { realPublicCardId, rewriteCanonicalCardPath } from './card-stub.js';
export { artistNameFromSlug, artistSlug } from './artist-name.js';
import { peekStoredCardPage, rememberStoredCardPage } from './card-page-cache.js';
import {
  clearListingsInflight,
  dropListing,
  invalidateListings,
  listingsFetchEpoch,
  listingsInflightFor,
  mergeCreatedListing,
  omitListings,
  peekHasListingRows,
  peekListings,
  peekSellerListings,
  rememberCreatedListing,
  rememberListings,
  rememberSellerListings,
  setListingsInflight,
} from './listings-cache.js';
import {
  homepageDerivativeUrl,
  homepageMatchesCatalog,
  leftoverKeyMatchesCard,
  ownCatalogImage,
  preferFullImage,
  rasterSiblings,
  rewritePublicImage,
} from './image-urls.js';
import {
  WORKING_MESSAGE,
  isApiRequestPath,
  isNetworkError,
  isOriginDownError,
  noteOriginDown,
  isTunnelHtml,
} from './working-page.js';

export { readRecentCardIds, rememberCardId, peekRecentTile, homepageDerivativeUrl, preferFullImage, rasterSiblings, fetchCardTiles, attachRecentsToHome, isPublicRailsVector, publicIdFromScanHit };

const WATCH_KEY = 'pokoin.watchlistIds';

export function readWatchlistIds() {
  return readIdList(WATCH_KEY);
}

export function toggleWatchlist(cardId) {
  const id = String(cardId || '');
  if (!/^\d+$/.test(id)) {
    return false;
  }
  const current = readWatchlistIds();
  const on = current.includes(id);
  const next = on ? current.filter((value) => value !== id) : [id, ...current].slice(0, 48);
  localStorage.setItem(WATCH_KEY, JSON.stringify(next));
  return !on;
}

function readIdList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((id) => String(id)).filter((id) => /^\d+$/.test(id));
  } catch (_) {
    return [];
  }
}

export async function getJson(path, options = {}) {
  const framed = framedByChromeExtension();
  let response;
  try {
    response = await fetch(publicApiUrl(withGameQuery(path)), {
      headers: {
        Accept: 'application/json',
        ...gameRequestHeaders(),
        ...(options.headers || {}),
      },
      method: options.method || 'GET',
      body: options.body,
      signal: options.signal,
      cache: options.cache,
    });
  } catch (err) {
    if (isApiRequestPath(path) && isNetworkError(err)) {
      if (!framed) {
        noteOriginDown();
      }
      const error = new Error(WORKING_MESSAGE);
      error.cause = err;
      throw error;
    }
    throw err;
  }
  if (!response.ok) {
    const raw = await response.text();
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch (_) {
      body = {};
    }
    if (isOriginDownError({ message: body.error || body.message || '' }, response.status, raw) || isTunnelHtml(raw)) {
      if (!framed) {
        noteOriginDown();
      }
      const error = new Error(WORKING_MESSAGE);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    const error = new Error(body.error || body.message || body.detail || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (isTunnelHtml(raw)) {
      if (!framed) {
        noteOriginDown();
      }
      throw new Error(WORKING_MESSAGE);
    }
    throw err;
  }
}

function isViteDev() {
  try {
    return Boolean(typeof import.meta !== 'undefined' && import.meta.env?.DEV);
  } catch (_) {
    return false;
  }
}

export async function fetchHome(recentIds = []) {
  // Pokemon SPA wants the public rails vector (New + Rising + Featured).
  // `GET /api/marketplace-home` on api.pokoin.com is Flutter hydrate (~170 KB,
  // no newArrivalIds). On pokoin.com the origin Worker serves the rails vector
  // instead. Vite proxies /api to api.pokoin.com, so skip that hop in dev.
  // Recents attach synchronously. Missing tiles are Home's job after paint.
  if (isPokemonGame()) {
    if (!isViteDev()) {
      try {
        const payload = await getJson('/api/marketplace-home?v=rising-month', { cache: 'no-store' });
        if (isPublicRailsVector(payload)) {
          return attachRecentsToHome(payload, recentIds);
        }
      } catch (err) {
        if (isOriginDownError(err, err?.status, err?.message)) {
          throw err;
        }
        /* lists / oracle below */
      }
    }
    try {
      const listed = await fetchHomeFromLists(recentIds);
      if (listed?.cards?.length || listed?.sections?.newArrivalIds?.length) {
        return listed;
      }
    } catch (err) {
      if (isOriginDownError(err, err?.status, err?.message)) {
        throw err;
      }
      /* oracle below */
    }
  }
  const payload = await getJson('/api/marketplace-home-page');
  if (payload?.cards?.length) {
    payload.cards = payload.cards.map((card) => applyTilePrice(card));
  }
  return attachRecentsToHome(payload, recentIds);
}

export function fetchSearch({
  query,
  offset = 0,
  limit = 48,
  productType = '',
  productSearchOnly = false,
  lang,
  printLang,
  signal,
} = {}) {
  const params = new URLSearchParams({
    query: query || '',
    limit: String(limit),
    offset: String(offset),
    includeFacets: '0',
    lang: lang || getSearchLang(),
    search_language: lang || getSearchLang(),
  });
  if (productType) {
    params.set('productType', productType);
  }
  if (productSearchOnly) {
    params.set('productSearchOnly', '1');
  }
  if (printLang && printLang !== 'all') {
    params.set('print_language', printLang);
  }
  return getJson(`/api/marketplace-search-page?${params}`, { signal });
}

export async function fetchExactNameCards(name, {
  excludeId,
  signal,
  lang,
  limit = 96,
} = {}) {
  const query = exactNameQuery(name);
  if (!query) {
    return [];
  }
  const pageSize = Math.min(96, Math.max(12, Number(limit) || 96));
  let offset = 0;
  const collected = [];
  const seen = new Set();
  for (let page = 0; page < 8; page += 1) {
    const data = await fetchSearch({
      query,
      offset,
      limit: pageSize,
      lang,
      signal,
    });
    const rows = filterExactNameRows(data?.cards || [], name, { excludeId })
      .map(cardFromCatalogRow)
      .filter((card) => card.id);
    for (const card of rows) {
      if (seen.has(String(card.id))) {
        continue;
      }
      seen.add(String(card.id));
      collected.push(card);
    }
    if (!data?.hasMore || !rows.length) {
      break;
    }
    offset += pageSize;
  }
  return collected;
}

export function fetchSuggest(query, { limit = 20, signal, lang, printLang, match } = {}) {
  const params = new URLSearchParams({
    q: query || '',
    limit: String(limit),
    search_language: lang || getSearchLang(),
    print_language: printLang || 'all',
  });
  // Corrected semantic lookups require every token to hit server-side so a
  // resolver anchor cannot silently vanish (default Meili "last" relaxes).
  if (match === 'all') {
    params.set('match', 'all');
  }
  return getJson(`/api/marketplace-suggest?${params}`, { signal });
}

const SEARCH_WARMUP_TTL_MS = 5 * 60 * 1000;
let searchWarmupAt = 0;
let searchWarmupTimer = 0;

/**
 * After marketplace home paints: wake the typeahead path so the first keystroke
 * is not a cold Meili/TLS hit. Same idea as Flutter `_ensureFirstCharWarmup`.
 * Token-predict warmup is Pokemon-only (name-token table). Best-effort; never
 * throws into UI.
 */
export function warmupSearchBar() {
  if (typeof window === 'undefined') {
    return;
  }
  if (Date.now() - searchWarmupAt < SEARCH_WARMUP_TTL_MS) {
    return;
  }
  if (searchWarmupTimer) {
    return;
  }
  const run = () => {
    searchWarmupTimer = 0;
    searchWarmupAt = Date.now();
    const lang = getSearchLang();
    fetchSuggest('m', { limit: 4, lang })
      .then((data) => {
        rememberSuggestGroups(data.groups);
        preloadSuggestThumbs(collectPrintingThumbUrls(data.groups, (printing) => (
          imageSrc(cardFromAutocomplete(printing), 'suggest')
        )));
      })
      .catch(() => {});
    if (isPokemonGame()) {
      getJson(`/api/searchbar-token-predict?warmup=1&limit=1&search_language=${encodeURIComponent(lang)}`).catch(() => {});
    }
  };
  if (typeof window.requestIdleCallback === 'function') {
    searchWarmupTimer = window.requestIdleCallback(run, { timeout: 800 });
    return;
  }
  searchWarmupTimer = window.setTimeout(run, 0);
}

const cardCache = new Map();
const cardInflight = new Map();

function cardCacheKey(cardId, lang = 'en') {
  return `${String(lang || 'en')}:${String(cardId)}`;
}

function rememberMap(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

export function peekCard(cardId, { lang = 'en' } = {}) {
  const key = cardCacheKey(cardId, lang);
  if (cardCache.has(key)) {
    return cardCache.get(key);
  }
  const stored = peekStoredCardPage(cardId, { lang });
  if (stored) {
    rememberMap(cardCache, key, stored, 24);
    return stored;
  }
  return null;
}

const canonicalPathCache = new Map();
const canonicalPathInflight = new Map();

function canonicalPathKey(cardId, lang = 'en') {
  return cardCacheKey(cardId, lang);
}

export function peekCanonicalPath(cardId, { lang = 'en' } = {}) {
  const cached = peekCard(cardId, { lang });
  const fromCard = cached?.card?.canonicalPath || cached?.card?.canonical_path || cached?.canonicalPath;
  if (fromCard) {
    return fromCard;
  }
  return canonicalPathCache.get(canonicalPathKey(cardId, lang)) || '';
}

export function fetchCanonicalPath(cardId, { lang = 'en' } = {}) {
  const id = String(cardId || '');
  const known = peekCanonicalPath(id, { lang });
  if (known) {
    return Promise.resolve(known);
  }
  const key = canonicalPathKey(id, lang);
  if (canonicalPathInflight.has(key)) {
    return canonicalPathInflight.get(key);
  }
  const params = new URLSearchParams({ cardId: id });
  if (lang) {
    params.set('language', lang);
  }
  const pending = getJson(`/api/marketplace-card-url?${params}`).then((data) => {
    const path = data?.canonicalPath || data?.canonical_path || '';
    if (path) {
      rememberMap(canonicalPathCache, key, path, 48);
    }
    canonicalPathInflight.delete(key);
    return path;
  }, (err) => {
    canonicalPathInflight.delete(key);
    throw err;
  });
  canonicalPathInflight.set(key, pending);
  return pending;
}

export function fetchCardSales(cardId, {
  condition,
  language,
  reverse,
  firstEdition,
  graded,
  slices,
} = {}) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) {
    return Promise.resolve({
      rows: [],
      slices: [],
      series: { days: [], change24hPct: null },
      filters: {
        conditions: [], languages: [], reverse: [], firstEdition: [], graded: [],
      },
      slice: {
        condition: null, language: null, reverse: null, firstEdition: null, graded: null,
      },
    });
  }
  const params = new URLSearchParams({ cardId: id });
  if (slices === true || slices === '1') {
    params.set('slices', '1');
    return getJson(`/api/marketplace-card-sales?${params}`);
  }
  if (condition) {
    params.set('condition', condition);
  }
  if (language) {
    params.set('language', language);
  }
  if (reverse === true || reverse === false || reverse === '0' || reverse === '1') {
    params.set('reverse', reverse === true || reverse === '1' ? '1' : '0');
  }
  if (firstEdition === true || firstEdition === '1') {
    params.set('firstEdition', '1');
  }
  if (graded === true || graded === '1') {
    params.set('graded', '1');
  }
  return getJson(`/api/marketplace-card-sales?${params}`);
}

/** Tile / versions last-median: series only, never `slices=1`. */
export async function fetchLastMedianPknMap(cardIds) {
  const ids = [...new Set((cardIds || []).map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)))].slice(0, 48);
  if (!ids.length) {
    return {};
  }
  const pairs = await Promise.all(ids.map(async (id) => {
    try {
      const data = await fetchCardSales(id);
      return [id, lastMedianFromSales(data)];
    } catch (_) {
      return [id, null];
    }
  }));
  const byId = {};
  for (const [id, pkn] of pairs) {
    if (pkn > 0) {
      byId[id] = pkn;
    }
  }
  return byId;
}

export async function fillMissingLastMedianPrices(cards) {
  const ids = idsMissingTilePrice(cards);
  if (!ids.length) {
    return cards || [];
  }
  const medians = await fetchLastMedianPknMap(ids);
  if (!Object.keys(medians).length) {
    return cards || [];
  }
  return applyLastMedianPrices(cards, medians);
}

export async function overlayCatalogTilePrices(cards) {
  const ids = idsMissingTilePrice(cards);
  if (!ids.length) {
    return cards || [];
  }
  const wanted = ids.slice(0, 48);
  let rows = [];
  try {
    const body = await getJson(`/api/marketplace-card-tiles?ids=${wanted.join(',')}`);
    rows = Array.isArray(body?.cards) ? body.cards : [];
  } catch (_) {
    return cards || [];
  }
  const medians = {};
  for (const row of rows) {
    const priced = applyTilePrice(cardFromCatalogRow(row));
    const pkn = tilePricePkn(priced);
    if (pkn != null) {
      medians[String(priced.id)] = pkn;
    }
  }
  if (!Object.keys(medians).length) {
    return cards || [];
  }
  return applyLastMedianPrices(cards, medians);
}

export async function fillMissingTilePrices(cards) {
  const fromTiles = await overlayCatalogTilePrices(cards);
  return fillMissingLastMedianPrices(fromTiles);
}

export function fetchCard(cardId, { lang = 'en', slug = '', includeOffers = false, fresh = false } = {}) {
  const key = cardCacheKey(cardId, lang);
  if (!fresh && !includeOffers && cardCache.has(key)) {
    return Promise.resolve(cardCache.get(key));
  }
  if (!fresh && !includeOffers && cardInflight.has(key)) {
    return cardInflight.get(key);
  }
  const params = new URLSearchParams({ cardId: String(cardId) });
  if (lang) {
    params.set('lang', lang);
  }
  if (slug) {
    params.set('slug', slug);
  }
  if (includeOffers) {
    params.set('includeOffers', '1');
  }
  const pending = getJson(`/api/marketplace-card-page?${params}`).then((data) => {
    if (!includeOffers) {
      let next = data;
      if (!hasNeighborArrows(data?.neighbors)) {
        const peeked = peekNeighbors(cardId);
        if (hasNeighborArrows(peeked)) {
          next = { ...data, neighbors: peeked };
        }
      }
      rememberMap(cardCache, key, next, 24);
      rememberStoredCardPage(cardId, next, { lang });
      cardInflight.delete(key);
      return next;
    }
    return data;
  }, (err) => {
    cardInflight.delete(key);
    throw err;
  });
  if (!includeOffers) {
    cardInflight.set(key, pending);
  }
  return pending;
}

export function fetchVersionSet(cardId) {
  const id = String(cardId || '').trim();
  if (!id) {
    return Promise.reject(new Error('cardId is required.'));
  }
  return getJson(`/api/marketplace-version-set?cardId=${encodeURIComponent(id)}`);
}

export {
  dropListing,
  invalidateListings,
  mergeCreatedListing,
  omitListings,
  peekHasListingRows,
  peekListings,
  rememberCreatedListing,
};

export function fetchListings(cardId, { limit = 40, fresh = false } = {}) {
  const id = String(cardId || '');
  if (!fresh) {
    const cached = peekListings(id);
    if (cached) {
      return Promise.resolve(cached);
    }
    const inflight = listingsInflightFor(id);
    if (inflight) {
      return inflight;
    }
  }
  const epoch = listingsFetchEpoch(id);
  const params = new URLSearchParams({
    cardId: id,
    nativeOnly: '1',
    limit: String(limit),
  });
  if (fresh) {
    params.set('_', String(Date.now()));
  }
  const pending = getJson(`/api/marketplace-listings?${params}`, {
    cache: 'no-store',
  }).then((data) => {
    const kept = rememberListings(id, data, epoch);
    clearListingsInflight(id);
    return kept;
  }, (err) => {
    if (listingsFetchEpoch(id) === epoch) {
      clearListingsInflight(id);
    }
    throw err;
  });
  setListingsInflight(id, pending);
  return pending;
}

export function createListing(body, token) {
  return getJson('/api/marketplace-listings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export function cancelListing(listingId, token, sellerUid) {
  const id = String(listingId || '');
  const params = new URLSearchParams({ id });
  return getJson(`/api/marketplace-listings?${params}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      sellerUid,
      status: 'inactive',
    }),
  });
}

export function postWatchlist(cardId, action) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return;
  }
  fetch(publicApiUrl('/api/marketplace-watchlist'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cardId: id,
      action: action === 'add' ? 'add' : 'remove',
    }),
    keepalive: true,
  }).catch(() => {});
}

export function artistHref(name, lang = 'en', filter = '') {
  const slug = artistSlug(name);
  const language = String(lang || 'en').toLowerCase() || 'en';
  const extra = String(filter || '').replace(/^\/+|\/+$/g, '');
  if (!slug) {
    return '';
  }
  return extra
    ? `/marketplace/${language}/artists/${slug}/${extra}`
    : `/marketplace/${language}/artists/${slug}`;
}

export function versionsHref(card, lang = 'en', hash = '') {
  const canonical = String(card?.canonicalPath || card?.canonical_path || '').replace(/\/$/, '');
  const id = publicCardId(card);
  const language = String(lang || card?.lang || 'en').toLowerCase() || 'en';
  const path = canonical
    ? `${canonical}/versions`
    : (id ? `/marketplace/${language}/cards/${id}/versions` : '');
  if (!path) {
    return '/marketplace';
  }
  const frag = String(hash || '').replace(/^#/, '');
  return frag ? `${path}#${frag}` : path;
}

export function cardFromCatalogRow(row = {}) {
  const id = String(row.id || row.card_id || '');
  const setName = row.set || row.set_name || row.expansion_name || '';
  const number = row.number || row.card_number || row.expansion_number || row.product_variant || '';
  const image = ownCatalogImage({
    ...row,
    id,
    name: row.name || '',
    canonicalPath: row.canonicalPath || row.canonical_path || '',
  }, preferFullImage(
    row.gridImageUrl
    || row.heroImageUrl
    || row.cdn_image_url
    || row.image_url
    || row.imageUrl
    || row.cdnImageUrl
    || '',
  ));
  const path = row.canonicalPath || row.canonical_path || '';
  return applyTilePrice({
    ...row,
    id,
    card_id: id,
    name: sanitizeCardName(row.name || ''),
    set: setName,
    set_name: setName,
    number,
    rarity: row.rarity || '',
    productType: row.product_type || row.productType || 'card',
    itemKind: row.item_kind || row.itemKind || 'single',
    canonicalPath: path,
    canonical_path: path,
    artist: row.artist || row.illustrator || '',
    illustrator: row.illustrator || row.artist || '',
    nationality: row.nationality || expansionNationality(setName) || '',
    trainerName: row.trainer_name || row.trainerName || '',
    gridImageUrl: image,
    heroImageUrl: preferFullImage(row.heroImageUrl || image),
    imageUrl: image,
    emoji: row.emoji || row.cardIdentityEmoji || '',
    artShade: row.artShade || row.art_shade || '',
    artLayout: row.artLayout || row.art_layout || '',
    version: row.version || row.version_set || '',
    pokedexNum: Number(row.pokedex_num || row.pokedexNum) || 0,
    expansionSort: Number(row.expansion_sort || row.expansionSort) || 0,
    collectorSort: Number(row.collector_sort || row.collectorSort) || 0,
    artworkClusterSort: Number(row.artwork_cluster_sort || row.artworkClusterSort) || 0,
    pokedexSort: Number(row.pokedex_sort || row.pokedexSort) || 0,
    price: row.price || row.lowest_price_pkn || null,
    isMarketAvailable: row.isMarketAvailable === true || row.inStock === true,
    inStock: row.isMarketAvailable === true || row.inStock === true,
  });
}

const artistPageCache = new Map();
const artistPageInflight = new Map();
let artistSummariesCache = null;

function artistPageKey(slug, limit) {
  return `${String(slug || '').trim().toLowerCase()}:${Number(limit) || 0}`;
}

export function peekArtist(slug, limit = 5000) {
  return artistPageCache.get(artistPageKey(slug, limit)) || null;
}

export function fetchArtist(slug, { limit = 240 } = {}) {
  const key = artistPageKey(slug, limit);
  const hit = artistPageCache.get(key);
  if (hit) {
    return Promise.resolve(hit);
  }
  if (artistPageInflight.has(key)) {
    return artistPageInflight.get(key);
  }
  const params = new URLSearchParams({
    artistSlug: String(slug || ''),
    limit: String(limit),
  });
  const pending = getJson(`/api/marketplace-artist-cards?${params}`)
    .then((data) => {
      const mapped = {
        ...data,
        cards: (data.cards || []).map(cardFromCatalogRow).filter((card) => card.id),
      };
      artistPageCache.delete(key);
      artistPageCache.set(key, mapped);
      while (artistPageCache.size > 8) {
        artistPageCache.delete(artistPageCache.keys().next().value);
      }
      return mapped;
    })
    .finally(() => {
      artistPageInflight.delete(key);
    });
  artistPageInflight.set(key, pending);
  return pending;
}

export function fetchArtistSummaries({ limit = 1000 } = {}) {
  if (artistSummariesCache) {
    return Promise.resolve(artistSummariesCache);
  }
  const params = new URLSearchParams({
    summaries: '1',
    limit: String(limit),
  });
  return getJson(`/api/marketplace-artist-cards?${params}`).then((data) => {
    artistSummariesCache = data;
    return data;
  });
}

export function resetArtistCacheForTests() {
  artistPageCache.clear();
  artistPageInflight.clear();
  artistSummariesCache = null;
}

export async function fetchExpansions({ limit = 500 } = {}) {
  const cap = Number(limit) || 500;
  let cached = null;
  try {
    cached = await fetchSetIndexFromLists();
    if (cached?.expansions?.length >= cap) {
      return { ...cached, expansions: cached.expansions.slice(0, cap) };
    }
  } catch (_) {
    /* Oracle fallback below */
  }
  try {
    return await getJson(`/api/marketplace-expansion-page?limit=${encodeURIComponent(String(cap))}`);
  } catch (err) {
    if (cached?.expansions?.length) {
      return { ...cached, expansions: cached.expansions.slice(0, cap) };
    }
    throw err;
  }
}

export function clearWatchlist() {
  localStorage.setItem(WATCH_KEY, '[]');
}

export async function hydrateWatchlist() {
  const ids = readWatchlistIds();
  const tiles = await fetchCardTiles(ids).catch(() => []);
  const have = new Set(tiles.map((card) => String(card.id || card.card_id || '')));
  const missing = ids.filter((id) => !have.has(String(id)));
  const extras = await Promise.all(missing.map((id) => (
    fetchCard(id).then((data) => data?.card || null).catch(() => null)
  )));
  const cards = [...tiles, ...extras.filter(Boolean)].map(cardFromCatalogRow);
  const byId = new Map(cards.map((card) => [String(card.id), card]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

const expansionCache = new Map();
const expansionInflight = new Map();
/** Page at 48 as defense. The old Oracle SQL cap was 64 and lied hasMore=false. */
const EXPANSION_PAGE = 48;

function expansionCacheKey({ slug = '', expansionName = '', limit = 48, offset = 0 } = {}) {
  return JSON.stringify({ slug, expansionName, limit: Number(limit), offset: Number(offset) });
}

export function peekExpansion(opts = {}) {
  return expansionCache.get(expansionCacheKey(opts)) || null;
}

const printNationalityCache = new Map();
const printNationalityInflight = new Map();

/** Expansion nationality for the card desk. Cards themselves often omit the field. */
export function fetchPrintNationality(slug) {
  const key = String(slug || '').trim();
  if (!key) {
    return Promise.resolve('');
  }
  if (printNationalityCache.has(key)) {
    return Promise.resolve(printNationalityCache.get(key));
  }
  const peeked = peekExpansion({ slug: key, limit: EXPANSION_PAGE, offset: 0 });
  const fromPeek = String(peeked?.expansion?.nationality || '').trim();
  if (fromPeek) {
    printNationalityCache.set(key, fromPeek);
    return Promise.resolve(fromPeek);
  }
  if (printNationalityInflight.has(key)) {
    return printNationalityInflight.get(key);
  }
  const params = new URLSearchParams({ slug: key, limit: '1' });
  const pending = getJson(`/api/marketplace-expansion-page?${params}`)
    .then((data) => {
      const value = String(data?.expansion?.nationality || '').trim();
      printNationalityCache.set(key, value);
      return value;
    })
    .catch(() => '')
    .finally(() => {
      printNationalityInflight.delete(key);
    });
  printNationalityInflight.set(key, pending);
  return pending;
}

function rememberCompleteExpansion({ slug = '', expansionName = '' } = {}, data) {
  if (!data) {
    return data;
  }
  const complete = { ...data, hasMore: false };
  expansionCache.set(expansionCacheKey({ slug, expansionName, limit: EXPANSION_PAGE, offset: 0 }), complete);
  if (expansionName) {
    expansionCache.set(expansionCacheKey({ slug, expansionName: '', limit: EXPANSION_PAGE, offset: 0 }), complete);
  }
  return complete;
}

const promoFanCache = new Map();
const promoFanInflight = new Map();

export function peekPromoFanPool(slug) {
  return promoFanCache.get(String(slug || '').trim()) || null;
}

/** Set-rail chase pool for the home fan. No PKN overlay — the fan does not show price. */
export function fetchPromoFanPool(slug) {
  const key = String(slug || '').trim();
  if (!key) {
    return Promise.resolve([]);
  }
  if (promoFanCache.has(key)) {
    return Promise.resolve(promoFanCache.get(key));
  }
  if (promoFanInflight.has(key)) {
    return promoFanInflight.get(key);
  }
  const pending = fetchExpansionFromLists({ slug: key, limit: 200, offset: 0 })
    .catch(() => null)
    .then(async (rail) => {
      const fromRail = (rail?.cards || []).filter((card) => card?.id);
      if (fromRail.length) {
        promoFanCache.set(key, fromRail);
        return fromRail;
      }
      const params = new URLSearchParams({
        slug: key,
        limit: '120',
        offset: '0',
        productType: 'card',
      });
      const page = mapExpansionCards(await getJson(`/api/marketplace-expansion-page?${params}`).catch(() => null));
      const cards = (page?.cards || []).filter((card) => card?.id);
      promoFanCache.set(key, cards);
      return cards;
    })
    .finally(() => {
      promoFanInflight.delete(key);
    });
  promoFanInflight.set(key, pending);
  return pending;
}

function mapExpansionCards(data) {
  if (!data) {
    return data;
  }
  const nationality = String(data.expansion?.nationality || '').trim();
  return {
    ...data,
    cards: (data.cards || []).map((row) => {
      const card = cardFromCatalogRow(row);
      if (!card.id) {
        return null;
      }
      if (card.nationality || !nationality) {
        return card;
      }
      return { ...card, nationality };
    }).filter(Boolean),
  };
}

function mergeExpansionPayload(base, page) {
  if (!page) {
    return base;
  }
  if (!base?.cards?.length) {
    return page;
  }
  const total = Number(page?.expansion?.cardCount || page?.total || base.total || 0);
  const incoming = new Map((page.cards || []).map((card) => [String(card.id), card]));
  const cards = (base.cards || []).map((card) => {
    const next = incoming.get(String(card.id));
    if (!next) {
      return card;
    }
    const merged = { ...card, ...next };
    if (tilePricePkn(card) != null && tilePricePkn(next) == null) {
      merged.price = card.price;
      merged.lowest_price_pkn = card.lowest_price_pkn ?? card.price;
    }
    return applyTilePrice(merged);
  });
  return {
    ...base,
    total: total || base.total,
    cards,
    expansion: {
      ...(base.expansion || {}),
      ...(page.expansion || {}),
      ...(total > 0 ? { cardCount: total } : {}),
    },
    hasMore: page.hasMore ?? base.hasMore,
  };
}

export function fetchExpansion({ slug = '', expansionName = '', limit = 48, offset = 0, onUpdate } = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    productType: 'card',
  });
  if (slug) {
    params.set('slug', slug);
  }
  if (expansionName) {
    params.set('expansionName', expansionName);
  }
  const key = expansionCacheKey({ slug, expansionName, limit, offset });
  if (offset === 0 && expansionCache.has(key)) {
    return Promise.resolve(expansionCache.get(key));
  }
  if (offset === 0 && expansionInflight.has(key)) {
    return expansionInflight.get(key);
  }
  const fromLists = slug
    ? fetchExpansionFromLists({ slug, limit, offset }).catch(() => null)
    : Promise.resolve(null);
  const pageSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(6000)
    : undefined;
  const fromPage = getJson(`/api/marketplace-expansion-page?${params}`, { signal: pageSignal }).catch(() => null);
  const pending = fromLists.then(async (cached) => {
    // Rail / first SQL page is metadata only. The set desk waits for
    // fetchExpansionCards (hasMore false) before painting tiles.
    const fromRail = mapExpansionCards(cached);
    if (fromRail?.cards?.length) {
      const pricedRail = {
        ...fromRail,
        cards: await fillMissingTilePrices(fromRail.cards),
      };
      expansionCache.set(key, pricedRail);
      void fromPage.then(async (page) => {
        if (!page) {
          return;
        }
        const merged = mergeExpansionPayload(pricedRail, mapExpansionCards(page));
        merged.cards = await fillMissingTilePrices(merged.cards || []);
        expansionCache.set(key, merged);
        onUpdate?.(merged);
      });
      return pricedRail;
    }
    const page = mapExpansionCards(await fromPage);
    if (page?.cards?.length) {
      return {
        ...page,
        cards: await fillMissingTilePrices(page.cards),
      };
    }
    throw new Error('Expansion failed.');
  }).then((data) => {
    if (offset === 0) {
      if (!expansionCache.has(key) && data) {
        expansionCache.set(key, data);
      }
      expansionInflight.delete(key);
    }
    return data;
  }, (err) => {
    expansionInflight.delete(key);
    throw err;
  });
  if (offset === 0) {
    expansionInflight.set(key, pending);
  }
  return pending;
}

export async function fetchExpansionCards({ slug = '', expansionName = '' } = {}) {
  const cards = [];
  const seen = new Set();
  let offset = 0;
  let expansion = null;
  for (let page = 0; page < 40; page += 1) {
    const data = await fetchExpansion({
      slug,
      expansionName,
      limit: EXPANSION_PAGE,
      offset,
    });
    expansion = data.expansion || expansion;
    const chunk = data.cards || [];
    for (const row of chunk) {
      const id = String(row.id || row.card_id || '');
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      cards.push(row);
    }
    if (chunk.length < EXPANSION_PAGE) {
      return rememberCompleteExpansion({ slug, expansionName }, { cards, hasMore: false, expansion });
    }
    offset += chunk.length;
  }
  return { cards, hasMore: true, expansion };
}

const neighborCache = new Map();

function neighborCardId(card) {
  return String(card?.id || card?.card_id || '');
}

export function peekNeighbors(cardId) {
  return neighborCache.get(String(cardId || '')) || null;
}

export function hasNeighborArrows(neighbors) {
  return Boolean(neighbors?.prev?.[0] || neighbors?.next?.[0]);
}

export function neighborsOrPeek(cardId, neighbors) {
  if (hasNeighborArrows(neighbors)) {
    return { prev: neighbors.prev || [], next: neighbors.next || [] };
  }
  return peekNeighbors(cardId) || { prev: [], next: [] };
}

export function rememberNeighbors(center, neighbors) {
  const id = neighborCardId(center);
  if (!id) {
    return;
  }
  const prev = [...(neighbors?.prev || [])];
  const next = [...(neighbors?.next || [])];
  if (!prev.length && !next.length) {
    return;
  }
  neighborCache.set(id, { prev, next });
  if (next[0]) {
    const nid = neighborCardId(next[0]);
    if (nid) {
      neighborCache.set(nid, {
        prev: [center, ...prev].filter((row) => neighborCardId(row) && neighborCardId(row) !== nid).slice(0, 3),
        next: next.slice(1).filter((row) => neighborCardId(row) !== nid).slice(0, 3),
      });
    }
  }
  if (prev[0]) {
    const pid = neighborCardId(prev[0]);
    if (pid) {
      neighborCache.set(pid, {
        prev: prev.slice(1).filter((row) => neighborCardId(row) !== pid).slice(0, 3),
        next: [center, ...next].filter((row) => neighborCardId(row) && neighborCardId(row) !== pid).slice(0, 3),
      });
    }
  }
  while (neighborCache.size > 64) {
    const oldest = neighborCache.keys().next().value;
    neighborCache.delete(oldest);
  }
}

function slugFromCard(card) {
  const path = String(card?.canonicalPath || card?.canonical_path || '');
  const parts = path.split('/').filter(Boolean);
  return parts[4] || '';
}

function preloadCardArt(card) {
  const src = imageSrc(card, 'hero') || imageSrc(card, 'grid');
  for (const url of rasterSiblings(src)) {
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.src = url;
  }
}

export function warmupCard(card, { lang = 'en', listings = false } = {}) {
  const id = neighborCardId(card);
  if (!id) {
    return;
  }
  preloadCardArt(card);
  fetchCard(id, { lang, slug: slugFromCard(card), includeOffers: false })
    .then((data) => {
      if (hasNeighborArrows(data.neighbors)) {
        rememberNeighbors(data.card, data.neighbors);
      }
      preloadCardArt(data.card);
    })
    .catch(() => {});
  if (listings) {
    fetchListings(id).catch(() => {});
  }
}

export function warmupNeighbors(neighbors, { lang = 'en' } = {}) {
  const prev = neighbors?.prev || [];
  const next = neighbors?.next || [];
  [next[0], prev[0]].filter(Boolean).forEach((card, index) => {
    const run = () => warmupCard(card, { lang, listings: true });
    if (index === 0) {
      run();
      return;
    }
    setTimeout(run, 40);
  });
}

export function fetchAutocomplete(query, { limit = 8, signal } = {}) {
  return getJson('/api/marketplace-autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      search_term: query,
      result_limit: limit,
      search_language: getSearchLang(),
    }),
    signal,
  });
}

export function postEvent({ cardId, eventType, metadata = {} }) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return;
  }
  const body = JSON.stringify({
    cardId: id,
    eventType,
    source: 'react-market',
    metadata,
  });
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon(publicApiUrl('/api/marketplace-event'), blob);
    return;
  }
  fetch(publicApiUrl('/api/marketplace-event'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

export function cardHref(card) {
  const id = realPublicCardId(card?.id || card?.card_id || '');
  const path = rewriteCanonicalCardPath(card?.canonicalPath || card?.canonical_path, id, getSearchLang());
  if (path) {
    return path;
  }
  return '/marketplace';
}

export function publicCardId(card) {
  return realPublicCardId(String(card?.id || card?.card_id || ''));
}

export function imageSrc(card, kind = 'grid') {
  if (kind === 'hero') {
    return ownCatalogImage(card, preferFullImage(
      card?.heroImageUrl
      || card?.imageUrl
      || card?.cdn_image_url
      || card?.image_url
      || card?.gridImageUrl
      || card?.tileImageUrl
      || card?.homepageImageUrl
      || card?.homepage_image_url,
    ));
  }
  if (kind === 'suggest') {
    const full = ownCatalogImage(card, preferFullImage(
      card?.gridImageUrl || card?.cdn_image_url || card?.image_url || card?.imageUrl || card?.image,
    ));
    const advertised = card?.tileImageUrl || card?.homepageImageUrl || card?.homepage_image_url || '';
    if (advertised && leftoverKeyMatchesCard(advertised, publicCardId(card)) && homepageMatchesCatalog(advertised, full || advertised)) {
      return homepageDerivativeUrl(advertised);
    }
    if (full) {
      return homepageDerivativeUrl(full);
    }
    return rewritePublicImage(
      card?.gridImageUrl || card?.cdn_image_url || card?.image_url || card?.imageUrl || card?.image,
      { allowPreview: true },
    );
  }
  const full = ownCatalogImage(card, preferFullImage(
    card?.gridImageUrl
    || card?.imageUrl
    || card?.cdn_image_url
    || card?.image_url,
  ));
  const advertised = card?.tileImageUrl || card?.homepageImageUrl || card?.homepage_image_url || '';
  if (advertised && leftoverKeyMatchesCard(advertised, publicCardId(card)) && homepageMatchesCatalog(advertised, full || advertised)) {
    return homepageDerivativeUrl(advertised);
  }
  return homepageDerivativeUrl(full || advertised);
}

export function cardFromAutocomplete(row = {}) {
  const id = String(row.card_id || row.id || '');
  const live = row.live === true || id.startsWith('live:');
  const image = ownCatalogImage({
    id,
    name: row.name,
    canonicalPath: row.canonicalPath || row.canonical_path || row.href,
  }, preferFullImage(row.image || row.cdn_image_url || row.image_url));
  return {
    id,
    card_id: id,
    ct_id: row.ct_id,
    name: sanitizeCardName(row.name),
    localized_name: sanitizeCardName(row.localized_name || row.localizedName || ''),
    set: row.set_name || row.set,
    localized_set: row.localized_set || row.localizedSet || '',
    number: row.card_number || row.number,
    rarity: row.rarity,
    localized_rarity: row.localized_rarity || row.localizedRarity || '',
    itemKind: row.item_kind,
    productType: row.product_type,
    canonicalPath: row.canonicalPath || row.canonical_path || row.href,
    image,
    image_url: image,
    gridImageUrl: image,
    heroImageUrl: image,
    isMarketAvailable: row.isMarketAvailable === true,
    nationality: row.nationality || expansionNationality(row.set_name || row.set) || '',
    expansionSymbolUrl: row.expansionSymbolUrl || row.expansion_symbol_url || row.defaultSymbolUrl || row.symbolImageUrl || '',
    live,
  };
}

export function prettySlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function setSlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

export { authFrom } from './punchouts.js';

export async function fetchForum({ categoryId = '', topicId = '', timeoutMs = 8000 } = {}) {
  const params = new URLSearchParams();
  if (categoryId) params.set('categoryId', categoryId);
  if (topicId) params.set('topicId', topicId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const query = params.toString();
    return await getJson(`/api/forum${query ? `?${query}` : ''}`, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Forum timed out. Try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createForumTopic({ categoryId, title, body }, token) {
  return getJson('/api/forum-create-topic', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ categoryId, title, body }),
  });
}

export function createForumPost({ topicId, body }, token) {
  return getJson('/api/forum-create-post', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ topicId, body }),
  });
}

export function uploadForumMedia({ topicId, postId, imageBase64 }, token) {
  return getJson('/api/forum-upload-media', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ topicId, postId, imageBase64 }),
  });
}

export function createPknCheckout(body, token) {
  return getJson('/api/create-pkn-checkout-session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export function createMarketplaceOrder(body, token) {
  return getJson('/api/marketplace-orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export function confirmMarketplaceDelivery(orderId, token) {
  return getJson('/api/marketplace-orders?action=confirm-delivery', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderId }),
  });
}

export function markMarketplaceShipped(orderId, token) {
  return getJson('/api/marketplace-orders?action=mark-shipped', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderId }),
  });
}

export function reportMarketplaceProblem({ orderId, reason, notes }, token) {
  return getJson('/api/marketplace-orders?action=report-problem', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderId, reason, notes }),
  });
}

export function requestNftShipping(body, token) {
  return getJson('/api/marketplace-orders?action=nft-shipping-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export function unlockSilver(token) {
  return getJson('/api/unlock-silver', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: '{}',
  });
}

export function fetchSwapPools() {
  return getJson('/chain/swap/pools');
}

export function fetchSwapQuote({ pool, assetIn, amountIn }) {
  const params = new URLSearchParams({
    pool: String(pool || ''),
    assetIn: String(assetIn || 'PKN'),
    amountIn: String(Math.round(Number(amountIn) || 0)),
  });
  return getJson(`/chain/swap/quote?${params}`);
}

export function fetchWpknQuote({ direction, amountIn }) {
  const params = new URLSearchParams({
    direction: String(direction || 'pkn_to_wpkn'),
    amountIn: String(Math.round(Number(amountIn) || 0)),
  });
  return getJson(`/api/wpkn-pkn-quote?${params}`);
}

export function requestWpknQuote({ direction, amountIn }, token) {
  return getJson('/api/wpkn-exchange/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ direction, amountIn: Number(amountIn) }),
  });
}

export function requestWpknExchange({ quoteId, direction, toAddress }, token) {
  return getJson('/api/wpkn-exchange/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ quoteId, direction, toAddress }),
  });
}

export function fetchExpansionSymbols(token, { query = '', missingOnly = false } = {}) {
  const params = new URLSearchParams({ limit: '200' });
  if (query) params.set('query', query);
  if (missingOnly) params.set('missingLogoOnly', '1');
  return getJson(`/api/marketplace-expansion-symbols?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export function saveExpansionSymbol(body, token) {
  return getJson('/api/marketplace-expansion-symbols', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export async function identifyScan(file) {
  const body = new FormData();
  body.append('file', file, file.name || 'card.jpg');
  const params = new URLSearchParams({ catalog: scanCatalogId() });
  const response = await fetch(`/cardscan/identify?${params}`, { method: 'POST', body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Scan failed (${response.status})`);
  }
  return data;
}

export function mediaUrl(row) {
  return row?.public_url || row?.publicUrl || row?.url || '';
}

export async function fetchCardmarketRedirect(card) {
  const id = typeof card === 'object' ? publicCardId(card) : String(card || '');
  const leftover = leftoverBlueprintId(card);
  const params = new URLSearchParams({
    id,
    format: 'json',
  });
  if (leftover && leftover !== id) {
    params.set('blueprintId', leftover);
  }
  const data = await getJson(`/api/cardmarket-redirect?${params}`);
  return data.url || data.redirect || data.href || '';
}

/** CardTrader leftover blueprint. Never a public card_id (those 404 on cardtrader.com). */
export function leftoverBlueprintId(card) {
  if (card && typeof card === 'object') {
    const ct = Number(card.ct_id ?? card.ctId);
    if (Number.isSafeInteger(ct) && ct > 0) {
      return String(ct);
    }
  }
  return '';
}

/** Leftover CardTrader page. Empty when the SPA still needs /api/cardtrader-redirect. */
export function cardtraderPublicUrl(card) {
  const leftover = leftoverBlueprintId(card);
  return leftover ? `https://www.cardtrader.com/en/cards/${leftover}` : '';
}

export async function fetchCardtraderRedirect(card) {
  const direct = cardtraderPublicUrl(card);
  if (direct) {
    return direct;
  }
  const id = typeof card === 'object' ? publicCardId(card) : String(card || '');
  const params = new URLSearchParams({
    id,
    format: 'json',
  });
  const data = await getJson(`/api/cardtrader-redirect?${params}`);
  return data.url || data.redirect || data.href || '';
}

/** Direct leftover URL when known so the browser never 302s through pokoin.com. */
export function cardtraderHref(card) {
  const direct = cardtraderPublicUrl(card);
  if (direct) {
    return direct;
  }
  const id = typeof card === 'object' ? publicCardId(card) : String(card || '');
  const leftover = leftoverBlueprintId(card);
  const params = new URLSearchParams({ id });
  if (leftover && leftover !== id) {
    params.set('blueprintId', leftover);
  }
  return withGameQuery(`/api/cardtrader-redirect?${params}`);
}

export function vintedHref(card, hostname) {
  return vintedSearchUrl(card, game(hostname).id);
}

export function fileToDataUrl(file) {
  if (!file) {
    return Promise.resolve('');
  }
  if (file.size > 8 * 1024 * 1024) {
    return Promise.reject(new Error('Image must be under 8 MB.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

export function scanHitsOf(data) {
  const identity = String(data?.identity || '');
  const catalog = String(data?.catalog || '');
  const rows = data?.hits || data?.results || data?.predictions || data?.data?.hits || [];
  const stamp = (hit) => (
    hit && typeof hit === 'object'
      ? { ...hit, identity: hit.identity || identity, catalog: hit.catalog || catalog }
      : hit
  );
  if (Array.isArray(rows) && rows.length) {
    return rows.map(stamp);
  }
  if (data?.name || data?.blueprint_id || data?.blueprintId) {
    return [stamp(data)];
  }
  return [];
}

function flattenSuggest(data) {
  return (data?.groups || []).flatMap((group) => (
    (group.printings || []).map((row) => cardFromAutocomplete(row))
  ));
}

function namesMatch(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function numbersMatch(cardNumber, hitNumber) {
  if (!hitNumber) {
    return true;
  }
  const left = String(cardNumber || '').replace(/\s+/g, '');
  const right = String(hitNumber).replace(/\s+/g, '');
  return left === right || left.includes(right) || right.includes(left);
}

export async function catalogFromScanHit(hit) {
  const publicId = publicIdFromScanHit(hit);
  const name = String(hit?.name || hit?.card_name || hit?.productName || '').trim();
  const number = String(
    hit?.collector_number || hit?.collectorNumber || hit?.number || hit?.card_number || '',
  ).trim();
  const set = String(hit?.set || hit?.set_name || hit?.setName || '').trim();
  if (publicId) {
    try {
      const page = await fetchCard(publicId);
      if (page?.card) {
        return page.card;
      }
    } catch (_) {
      /* suggest / search next */
    }
  }
  const query = [name, number].filter(Boolean).join(' ');
  if (query) {
    try {
      const rows = flattenSuggest(await fetchSuggest(query, { limit: 16 }));
      const match = rows.find((card) => publicId && String(card.id) === publicId)
        || rows.find((card) => namesMatch(card.name, name) && numbersMatch(card.number, number) && (
          !set
          || String(card.set || '').toLowerCase().includes(set.toLowerCase())
          || set.toLowerCase().includes(String(card.set || '').toLowerCase())
        ))
        || rows.find((card) => namesMatch(card.name, name) && numbersMatch(card.number, number))
        || rows.find((card) => namesMatch(card.name, name));
      if (match) {
        return match;
      }
    } catch (_) {
      /* search next */
    }
    try {
      const rows = (await fetchSearch({ query, limit: 12 })).cards || [];
      const match = rows.find((card) => publicId && String(card.id || card.card_id) === publicId)
        || rows.find((card) => namesMatch(card.name, name) && numbersMatch(card.number || card.card_number, number));
      if (match) {
        return match;
      }
    } catch (_) {
      /* fall through */
    }
  }
  if (publicId) {
    return { id: publicId, card_id: publicId, name, set, number };
  }
  return null;
}

const sellerInflight = new Map();

export function fetchSellerByUsername(username, { limit = 20, signal } = {}) {
  const handle = String(username || '').trim();
  if (!handle) {
    return Promise.resolve({ listings: [] });
  }
  const cached = peekSellerListings(handle);
  if (cached) {
    return Promise.resolve(cached);
  }
  const key = handle.toLowerCase();
  const pending = sellerInflight.get(key);
  if (pending) {
    return pending;
  }
  const params = new URLSearchParams({
    sellerUsername: handle,
    nativeOnly: '1',
    limit: String(limit),
  });
  const request = getJson(`/api/marketplace-listings?${params}`, { signal }).then((data) => {
    sellerInflight.delete(key);
    return rememberSellerListings(handle, data);
  }, (err) => {
    sellerInflight.delete(key);
    throw err;
  });
  sellerInflight.set(key, request);
  return request;
}

export function fetchSellerListings(sellerUid, token, { limit = 40 } = {}) {
  const params = new URLSearchParams({
    sellerUid: String(sellerUid || ''),
    nativeOnly: '1',
    limit: String(limit),
  });
  return getJson(`/api/marketplace-listings?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Owned-card totals for the signed-in user. Uid comes from the bearer only. */
export function fetchCollectionSummary(token) {
  return getJson('/api/marketplace-collection-summary', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export function fetchPortfolio({ id = '', limit } = {}) {
  const cap = Number.isFinite(Number(limit))
    ? Number(limit)
    : (isPokemonGame() ? 400 : 2000);
  const params = new URLSearchParams({ limit: String(cap) });
  if (id) {
    params.set('id', String(id));
  }
  return getJson(`/api/marketplace-portfolio?${params}`);
}
