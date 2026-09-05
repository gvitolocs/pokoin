/** Homepage vector from Supabase rails. Cached 1 day. No recently-seen. */

export const HOME_CACHE_TTL_SEC = 86400;
export const HOME_BROWSER_TTL_SEC = 120;

export const HOME_RAILS = [
  ['new_cards', 'newArrivalIds', 12],
  ['featured', 'featuredIds', 12],
  ['best_sellers', 'bestSellerIds', 12],
  ['spotlight', 'spotlightIds', 16],
  ['top_sold', 'topSoldIds', 24],
];

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': `public, max-age=${HOME_BROWSER_TTL_SEC}, s-maxage=600, stale-while-revalidate=${HOME_CACHE_TTL_SEC}`,
  'cdn-cache-control': 'max-age=600, stale-while-revalidate=86400',
  'access-control-allow-origin': '*',
};

export function isHomePath(pathname) {
  return (
    pathname === '/api/marketplace-home' ||
    pathname === '/api/marketplace-home/' ||
    pathname === '/api/marketplace-home-page' ||
    pathname === '/api/marketplace-home-page/'
  );
}

export function isTilesPath(pathname) {
  return pathname === '/api/marketplace-card-tiles' || pathname === '/api/marketplace-card-tiles/';
}

export function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

export function applyTilePrice(card) {
  if (!card || typeof card !== 'object') {
    return card;
  }
  const keys = ['price', 'lowest_price_pkn', 'pricePkn', 'cheapestPricePkn'];
  let price = null;
  for (const key of keys) {
    const amount = Number(card[key]);
    if (Number.isFinite(amount) && amount > 0) {
      price = amount;
      break;
    }
  }
  if (price == null) {
    const eur = Number(card.medianSoldEur ?? card.median_sold_eur);
    if (Number.isFinite(eur) && eur > 0) {
      price = eur / 0.005;
    }
  }
  if (price == null) {
    return card;
  }
  return { ...card, price, lowest_price_pkn: price };
}

export function asCards(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((card) => card && cardId(card));
}

export function assembleHomeVector(rows, generatedAt = new Date().toISOString()) {
  const byRail = new Map((rows || []).map((row) => [String(row.id || ''), row]));
  const byId = new Map();
  const sections = {};
  let pknUsdt = 0.005;

  function remember(cards) {
    for (const card of asCards(cards)) {
      const id = cardId(card);
      if (!id) {
        continue;
      }
      const next = applyTilePrice({ ...card, id, card_id: card.card_id || id });
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, next);
        continue;
      }
      const merged = { ...prev, ...next };
      if (!(Number(next.price) > 0) && Number(prev.price) > 0) {
        merged.price = prev.price;
        merged.lowest_price_pkn = prev.lowest_price_pkn;
      }
      byId.set(id, applyTilePrice(merged));
    }
  }

  for (const [railId, sectionKey, limit] of HOME_RAILS) {
    const row = byRail.get(railId);
    const cards = asCards(row?.cards).slice(0, limit);
    remember(cards);
    sections[sectionKey] = cards.map(cardId).filter(Boolean);
    const rate = Number(row?.meta?.pknUsdt);
    if (Number.isFinite(rate) && rate > 0) {
      pknUsdt = rate;
    }
  }

  return {
    source: 'supabase',
    cacheTtl: HOME_CACHE_TTL_SEC,
    generatedAt,
    pknUsdt,
    cards: [...byId.values()],
    sections,
  };
}

function parseIds(raw, max = 60) {
  return [...new Set(String(raw || '').split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))].slice(0, max);
}

function jsonResponse(body, extra = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

async function supabaseGet(env, path) {
  const base = String(env.SUPABASE_URL || 'https://ruvtchmbtxvjqmquobij.supabase.co').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!key) {
    throw new Error('missing supabase anon key');
  }
  const response = await fetch(`${base}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`supabase ${response.status}`);
  }
  return response.json();
}

async function buildHome(env) {
  const ids = HOME_RAILS.map((row) => row[0]).join(',');
  const rows = await supabaseGet(
    env,
    `marketplace_rails?id=in.(${ids})&select=id,cards,meta,updated_at`,
  );
  const vector = assembleHomeVector(rows);
  if (!vector.cards.length) {
    throw new Error('empty home vector');
  }
  return vector;
}

async function buildTiles(env, ids) {
  if (!ids.length) {
    return { cards: [] };
  }
  const rows = await supabaseGet(
    env,
    `marketplace_card_tiles?card_id=in.(${ids.join(',')})&select=card_id,payload`,
  );
  const cards = (rows || [])
    .map((row) => applyTilePrice(row?.payload || {}))
    .filter((card) => cardId(card));
  return { source: 'supabase', cards };
}

export function stableHomeCacheRequest(url) {
  const key = new URL(url);
  key.pathname = '/api/marketplace-home';
  key.search = '';
  key.hash = '';
  return new Request(key.toString(), { method: 'GET' });
}

async function railsVersion(env) {
  const ids = HOME_RAILS.map((row) => row[0]).join(',');
  const rows = await supabaseGet(
    env,
    `marketplace_rails?select=updated_at&id=in.(${ids})&order=updated_at.desc&limit=1`,
  );
  return String(rows?.[0]?.updated_at || '0');
}

async function putHome(cache, cacheRequest, body, version, cacheState) {
  const response = jsonResponse(body, {
    'x-pokoin-home-cache': cacheState,
    'x-pokoin-rails-updated-at': version || '',
  });
  await cache.put(cacheRequest, response.clone());
  return response;
}

async function revalidateHome(env, cache, cacheRequest, hit) {
  try {
    const version = await railsVersion(env);
    if (hit.headers.get('x-pokoin-rails-updated-at') === version) {
      return;
    }
    const body = await buildHome(env);
    await putHome(cache, cacheRequest, body, version, 'revalidate');
  } catch (_) {
    /* keep serving the cached copy */
  }
}

export async function handleMarketplaceHomeRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS' && (isHomePath(url.pathname) || isTilesPath(url.pathname))) {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-max-age': '86400',
      },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  if (!isHomePath(url.pathname) && !isTilesPath(url.pathname)) {
    return null;
  }

  // One Piece / Riftbound use Oracle ?game= — do not serve Pokemon Supabase rails.
  const host = String(url.hostname || '').toLowerCase();
  const game = String(url.searchParams.get('game') || '').toLowerCase();
  if (
    host === 'onepiece.pokoin.com' ||
    host === 'riftbound.pokoin.com' ||
    game === 'one_piece' ||
    game === 'riftbound' ||
    game === 'one-piece'
  ) {
    return null;
  }

  const cache = caches.default;
  if (isTilesPath(url.pathname)) {
    let body;
    try {
      body = await buildTiles(env, parseIds(url.searchParams.get('ids')));
    } catch (_) {
      return jsonResponse(
        { cards: [], error: 'tiles unavailable' },
        { 'cache-control': 'private, no-store', 'x-pokoin-home-cache': 'error' },
        502,
      );
    }
    return jsonResponse(body, { 'x-pokoin-home-cache': 'miss' });
  }

  const cacheRequest = stableHomeCacheRequest(url);
  const hit = await cache.match(cacheRequest);
  if (hit) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(revalidateHome(env, cache, cacheRequest, hit));
    }
    const headers = new Headers(hit.headers);
    headers.set('x-pokoin-home-cache', 'hit');
    return new Response(hit.body, { status: hit.status, headers });
  }

  let body;
  let version = '';
  try {
    [body, version] = await Promise.all([
      buildHome(env),
      railsVersion(env).catch(() => ''),
    ]);
  } catch (_) {
    return null;
  }

  const response = jsonResponse(body, {
    'x-pokoin-home-cache': 'miss',
    'x-pokoin-rails-updated-at': version,
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheRequest, response.clone()));
  }
  return response;
}
