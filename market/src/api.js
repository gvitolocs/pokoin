import { fetchCardTiles, fetchExpansionFromLists, fetchHomeFromLists, fetchSetIndexFromLists } from './lists.js';

const RECENT_KEY = 'pokoin.recentCardIds';
const WATCH_KEY = 'pokoin.watchlistIds';

export function readRecentCardIds() {
  return readIdList(RECENT_KEY);
}

export function rememberCardId(cardId) {
  writeIdList(RECENT_KEY, cardId, 24);
}

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

function writeIdList(key, cardId, max) {
  const id = String(cardId || '');
  if (!/^\d+$/.test(id)) {
    return;
  }
  const next = [id, ...readIdList(key).filter((value) => value !== id)].slice(0, max);
  localStorage.setItem(key, JSON.stringify(next));
}

export async function getJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    method: options.method || 'GET',
    body: options.body,
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || body.message || body.detail || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return response.json();
}

export async function fetchHome(recentIds = []) {
  try {
    const cached = await fetchHomeFromLists(recentIds);
    if (cached?.cards?.length || cached?.sections?.newArrivalIds?.length) {
      return cached;
    }
  } catch (_) {
    /* Oracle fallback below */
  }
  const params = new URLSearchParams();
  if (recentIds.length) {
    params.set('recentCardIds', recentIds.join(','));
  }
  const query = params.toString();
  return getJson(`/api/marketplace-home-page${query ? `?${query}` : ''}`);
}

export function fetchSearch({
  query,
  offset = 0,
  limit = 48,
  productType = '',
  productSearchOnly = false,
} = {}) {
  const params = new URLSearchParams({
    query: query || '',
    limit: String(limit),
    offset: String(offset),
    includeFacets: '0',
  });
  if (productType) {
    params.set('productType', productType);
  }
  if (productSearchOnly) {
    params.set('productSearchOnly', '1');
  }
  return getJson(`/api/marketplace-search-page?${params}`);
}

export function fetchSuggest(query, { limit = 12, signal } = {}) {
  const params = new URLSearchParams({
    q: query || '',
    limit: String(limit),
    search_language: 'en',
  });
  return getJson(`/api/marketplace-suggest?${params}`, { signal });
}

const cardCache = new Map();
const cardInflight = new Map();
const listingsCache = new Map();
const listingsInflight = new Map();

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
  return cardCache.get(cardCacheKey(cardId, lang)) || null;
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

export function fetchCard(cardId, { lang = 'en', slug = '', includeOffers = false } = {}) {
  const key = cardCacheKey(cardId, lang);
  if (!includeOffers && cardCache.has(key)) {
    return Promise.resolve(cardCache.get(key));
  }
  if (!includeOffers && cardInflight.has(key)) {
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

export function peekListings(cardId) {
  return listingsCache.get(String(cardId || '')) || null;
}

export function invalidateListings(cardId) {
  const id = String(cardId || '');
  listingsCache.delete(id);
  listingsInflight.delete(id);
}

export function fetchListings(cardId, { limit = 40 } = {}) {
  const id = String(cardId || '');
  if (listingsCache.has(id)) {
    return Promise.resolve(listingsCache.get(id));
  }
  if (listingsInflight.has(id)) {
    return listingsInflight.get(id);
  }
  const params = new URLSearchParams({
    cardId: id,
    nativeOnly: '1',
    limit: String(limit),
  });
  const pending = getJson(`/api/marketplace-listings?${params}`).then((data) => {
    rememberMap(listingsCache, id, data, 24);
    listingsInflight.delete(id);
    return data;
  }, (err) => {
    listingsInflight.delete(id);
    throw err;
  });
  listingsInflight.set(id, pending);
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

export function postWatchlist(cardId, action) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return;
  }
  fetch('/api/marketplace-watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cardId: id,
      action: action === 'add' ? 'add' : 'remove',
    }),
    keepalive: true,
  }).catch(() => {});
}

export function artistSlug(name) {
  return String(name || '')
    .replace(/é/g, 'e')
    .replace(/É/g, 'E')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

export function versionsHref(card, lang = 'en') {
  const canonical = String(card?.canonicalPath || card?.canonical_path || '').replace(/\/$/, '');
  if (canonical) {
    return `${canonical}/versions`;
  }
  const id = publicCardId(card);
  const language = String(lang || card?.lang || 'en').toLowerCase() || 'en';
  return id ? `/marketplace/${language}/cards/${id}/versions` : '/marketplace';
}

export function cardFromCatalogRow(row = {}) {
  const id = String(row.id || row.card_id || '');
  const setName = row.set || row.set_name || row.expansion_name || '';
  const number = row.number || row.card_number || row.expansion_number || row.product_variant || '';
  const image = preferFullImage(
    row.gridImageUrl
    || row.heroImageUrl
    || row.cdn_image_url
    || row.image_url
    || row.imageUrl
    || row.cdnImageUrl
    || '',
  );
  const path = row.canonicalPath || row.canonical_path || '';
  return {
    ...row,
    id,
    card_id: id,
    name: row.name || '',
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
    trainerName: row.trainer_name || row.trainerName || '',
    gridImageUrl: image,
    heroImageUrl: preferFullImage(row.heroImageUrl || image),
    imageUrl: image,
    emoji: row.emoji || row.cardIdentityEmoji || '',
    price: row.price || row.lowest_price_pkn || null,
    isMarketAvailable: row.isMarketAvailable === true || row.inStock === true,
    inStock: row.isMarketAvailable === true || row.inStock === true,
  };
}

export function fetchArtist(slug, { limit = 240 } = {}) {
  const params = new URLSearchParams({
    artistSlug: String(slug || ''),
    limit: String(limit),
  });
  return getJson(`/api/marketplace-artist-cards?${params}`).then((data) => ({
    ...data,
    cards: (data.cards || []).map(cardFromCatalogRow).filter((card) => card.id),
  }));
}

export function fetchArtistSummaries({ limit = 80 } = {}) {
  const params = new URLSearchParams({
    summaries: '1',
    limit: String(limit),
  });
  return getJson(`/api/marketplace-artist-cards?${params}`);
}

export async function fetchExpansions({ limit = 500 } = {}) {
  try {
    const cached = await fetchSetIndexFromLists();
    if (cached?.expansions?.length) {
      return { ...cached, expansions: cached.expansions.slice(0, Number(limit) || 500) };
    }
  } catch (_) {
    /* Oracle fallback below */
  }
  return getJson(`/api/marketplace-expansion-page?limit=${encodeURIComponent(String(limit))}`);
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

function expansionCacheKey({ slug = '', expansionName = '', limit = 48, offset = 0 } = {}) {
  return JSON.stringify({ slug, expansionName, limit: Number(limit), offset: Number(offset) });
}

export function peekExpansion(opts = {}) {
  return expansionCache.get(expansionCacheKey(opts)) || null;
}

export function fetchExpansion({ slug = '', expansionName = '', limit = 48, offset = 0 } = {}) {
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
  const pending = (Number(offset) === 0 && slug
    ? fetchExpansionFromLists({ slug, limit, offset }).catch(() => null)
    : Promise.resolve(null)
  ).then((cached) => {
    if (cached?.cards?.length) {
      return cached;
    }
    return getJson(`/api/marketplace-expansion-page?${params}`);
  }).then((data) => {
    if (offset === 0) {
      expansionCache.set(key, data);
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

/** Page at 48 as defense. Oracle used to hard-cap SQL at 64 and lie hasMore=false. */
const EXPANSION_PAGE = 48;

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
      return { cards, hasMore: false, expansion };
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
      search_language: 'en',
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
    navigator.sendBeacon('/api/marketplace-event', blob);
    return;
  }
  fetch('/api/marketplace-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

export function cardHref(card) {
  if (card?.canonicalPath || card?.canonical_path) {
    return card.canonicalPath || card.canonical_path;
  }
  if (card?.id || card?.card_id) {
    return `/marketplace/en/cards/${card.id || card.card_id}`;
  }
  return '/marketplace';
}

export function publicCardId(card) {
  return String(card?.id || card?.card_id || '');
}

export function imageSrc(card, kind = 'grid') {
  if (kind === 'hero') {
    return preferFullImage(card?.heroImageUrl || card?.imageUrl || card?.cdn_image_url || card?.image_url);
  }
  if (kind === 'suggest') {
    return preferFullImage(card?.gridImageUrl || card?.cdn_image_url || card?.image_url || card?.imageUrl);
  }
  return preferFullImage(card?.gridImageUrl || card?.imageUrl || card?.cdn_image_url || card?.image_url);
}

export function preferFullImage(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/\/previews\//i.test(text) || /\/preview_/i.test(text)) {
    return '';
  }
  let next = text;
  try {
    const url = new URL(text, 'https://pokoin.com');
    if (url.hostname === 'cdn.pokoin.com') {
      next = `/card-images${url.pathname}${url.search}`;
    }
  } catch (_) {
    next = text;
  }
  if (/_homepage\.webp(?:\?|$)/i.test(next)) {
    return next;
  }
  return next.replace(/\.(png|webp)(\?|$)/i, '.jpg$2');
}

/** Catalog art is JPEG. Homepage tiles stay `_homepage.webp`. */
export function rasterSiblings(value) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }
  if (/_homepage\.webp(?:\?|$)/i.test(text)) {
    return [text];
  }
  const match = text.match(/^(.*)\.(jpe?g|png|webp)(\?.*)?$/i);
  if (!match) {
    return [text];
  }
  const jpeg = `${match[1]}.jpg${match[3] || ''}`;
  return text === jpeg ? [jpeg] : [jpeg, text];
}

export function cardFromAutocomplete(row = {}) {
  const id = String(row.card_id || row.id || '');
  return {
    id,
    card_id: id,
    ct_id: row.ct_id,
    name: row.name,
    set: row.set_name || row.set,
    number: row.card_number || row.number,
    rarity: row.rarity,
    itemKind: row.item_kind,
    productType: row.product_type,
    canonicalPath: row.canonicalPath || row.canonical_path || row.href,
    image_url: row.image || row.cdn_image_url || row.image_url,
    gridImageUrl: preferFullImage(row.image || row.cdn_image_url || row.image_url),
    heroImageUrl: preferFullImage(row.image || row.cdn_image_url || row.image_url),
    isMarketAvailable: row.isMarketAvailable === true,
  };
}

export function formatPkn(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return '';
  }
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} PKN`;
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
  const response = await fetch('/cardscan/identify', { method: 'POST', body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Scan failed (${response.status})`);
  }
  return data;
}

/** Scan Fast/Milo `id` is TCGplayer. Public card_id is CardTrader blueprint × 2. */
export function publicIdFromScanHit(hit) {
  const blueprint = String(hit?.blueprint_id || hit?.blueprintId || '').trim();
  if (!/^\d+$/.test(blueprint)) {
    return '';
  }
  try {
    return (BigInt(blueprint) * 2n).toString();
  } catch (_) {
    return '';
  }
}

export function mediaUrl(row) {
  return row?.public_url || row?.publicUrl || row?.url || '';
}

export async function fetchCardmarketRedirect(cardId) {
  const params = new URLSearchParams({
    id: String(cardId || ''),
    format: 'json',
  });
  const response = await fetch(`/api/cardmarket-redirect?${params}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409) {
    throw new Error(data.error || data.message || 'Cardmarket has no listing for this printing.');
  }
  if (!response.ok) {
    throw new Error(data.error || data.message || `Cardmarket failed (${response.status})`);
  }
  return data.url || data.redirect || data.href || '';
}

export function cardtraderHref(cardId) {
  return `/api/cardtrader-redirect?id=${encodeURIComponent(String(cardId || ''))}`;
}

export function vintedHref(name) {
  return `https://www.vinted.it/catalog?search_text=${encodeURIComponent(String(name || '').trim())}`;
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
  const rows = data?.hits || data?.results || data?.predictions || data?.data?.hits || [];
  if (Array.isArray(rows) && rows.length) {
    return rows;
  }
  if (data?.name || data?.blueprint_id || data?.blueprintId) {
    return [data];
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
