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
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function fetchHome(recentIds = []) {
  const params = new URLSearchParams();
  if (recentIds.length) {
    params.set('recentCardIds', recentIds.join(','));
  }
  const query = params.toString();
  return getJson(`/api/marketplace-home-page${query ? `?${query}` : ''}`);
}

export function fetchSearch({ query, offset = 0, limit = 48 } = {}) {
  const params = new URLSearchParams({
    query: query || '',
    limit: String(limit),
    offset: String(offset),
    includeFacets: '0',
  });
  return getJson(`/api/marketplace-search-page?${params}`);
}

export function fetchCard(cardId, { lang = 'en', slug = '', includeOffers = false } = {}) {
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
  return getJson(`/api/marketplace-card-page?${params}`);
}

export function fetchListings(cardId, { limit = 40 } = {}) {
  const params = new URLSearchParams({
    cardId: String(cardId),
    nativeOnly: '1',
    limit: String(limit),
  });
  return getJson(`/api/marketplace-listings?${params}`);
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

export function artistHref(name, lang = 'en') {
  const slug = String(name || '')
    .replace(/é/g, 'e')
    .replace(/É/g, 'E')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const language = String(lang || 'en').toLowerCase() || 'en';
  return slug ? `/marketplace/${language}/artists/${slug}` : '';
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
  return getJson(`/api/marketplace-expansion-page?${params}`);
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
  try {
    const url = new URL(text, 'https://pokoin.com');
    if (url.hostname === 'cdn.pokoin.com') {
      return `/card-images${url.pathname}${url.search}`;
    }
  } catch (_) {
    return text;
  }
  return text;
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
    canonicalPath: row.canonicalPath || row.canonical_path,
    image_url: row.cdn_image_url || row.image_url,
    gridImageUrl: preferFullImage(row.cdn_image_url || row.image_url),
    heroImageUrl: preferFullImage(row.cdn_image_url || row.image_url),
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

export function authFrom(path) {
  return `/auth?from=${encodeURIComponent(path || '/marketplace')}`;
}
