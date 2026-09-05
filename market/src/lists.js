import { applyTilePrice, tilePricePkn } from './pkn.js';

const viteEnv = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const SUPABASE_URL = String(
  viteEnv.VITE_SUPABASE_URL || 'https://ruvtchmbtxvjqmquobij.supabase.co',
).replace(/\/$/, '');

export const SUPABASE_ANON_KEY = String(viteEnv.VITE_SUPABASE_ANON_KEY || '');

const RAIL = {
  newCards: 'new_cards',
  featured: 'featured',
  bestSellers: 'best_sellers',
  spotlight: 'spotlight',
  topSold: 'top_sold',
  setIndex: 'set_index',
};

export function setRailId(slug) {
  return `set:${String(slug || '').trim()}`;
}

export function listsConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function isViteDev() {
  try {
    return Boolean(viteEnv.DEV);
  } catch (_) {
    return false;
  }
}

/** Worker/Supabase rails vector. Reject Flutter hydrate and Oracle newest-only page. */
export function isPublicRailsVector(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.source === 'supabase') {
    return true;
  }
  const sections = payload.sections || {};
  return Boolean(
    (sections.newArrivalIds || []).length
    && (sections.featuredIds || []).length
    && (sections.bestSellerIds || []).length
  );
}

function headers() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: 'application/json',
  };
}

async function rest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: headers(),
  });
  if (!response.ok) {
    const error = new Error(`Lists request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function asCards(value) {
  if (Array.isArray(value)) {
    return value.filter((card) => card && (card.id || card.card_id));
  }
  return [];
}

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

export async function fetchRail(id) {
  if (!listsConfigured() || !id) {
    return null;
  }
  const rows = await rest(
    `marketplace_rails?id=eq.${encodeURIComponent(id)}&select=id,cards,meta,updated_at`,
  );
  const row = rows?.[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    cards: asCards(row.cards),
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
    updatedAt: row.updated_at || '',
  };
}

export async function fetchCardTiles(ids) {
  const wanted = [...new Set((ids || []).map((id) => String(id)).filter((id) => /^\d+$/.test(id)))];
  if (!wanted.length) {
    return [];
  }
  if (!isViteDev()) {
    try {
      const response = await fetch(`/api/marketplace-card-tiles?ids=${wanted.join(',')}`, {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const body = await response.json();
        const cards = Array.isArray(body?.cards) ? body.cards : [];
        if (cards.length) {
          return cards.filter((card) => cardId(card));
        }
      }
    } catch (_) {
      /* supabase fallback below */
    }
  }
  if (!listsConfigured()) {
    return [];
  }
  const rows = await rest(
    `marketplace_card_tiles?card_id=in.(${wanted.join(',')})&select=card_id,payload`,
  );
  return (rows || []).map((row) => row.payload).filter((card) => cardId(card));
}

export function attachRecentsToHome(payload, recentIds = [], extraCards = []) {
  const ids = [...new Set((recentIds || []).map(String).filter((id) => /^\d+$/.test(id)))].slice(0, 24);
  const byId = new Map();
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
      if (!tilePricePkn(next) && tilePricePkn(prev)) {
        merged.price = prev.price;
        merged.lowest_price_pkn = prev.lowest_price_pkn;
      }
      byId.set(id, applyTilePrice(merged));
    }
  }
  remember(payload?.cards);
  remember(extraCards);
  const missingRecentIds = ids.filter((id) => !byId.has(id));
  return {
    ...payload,
    source: payload?.source || 'supabase',
    cards: [...byId.values()],
    missingRecentIds,
    sections: {
      ...(payload?.sections || {}),
      recentlySeenIds: ids.filter((id) => byId.has(id)),
    },
  };
}

export async function fetchHomeFromLists(recentIds = []) {
  if (!listsConfigured()) {
    return null;
  }
  const [newCards, featured, bestSellers, spotlight, topSold] = await Promise.all([
    fetchRail(RAIL.newCards),
    fetchRail(RAIL.featured),
    fetchRail(RAIL.bestSellers),
    fetchRail(RAIL.spotlight),
    fetchRail(RAIL.topSold),
  ]);
  const rails = [newCards, featured, bestSellers, spotlight, topSold].filter(Boolean);
  if (!rails.length) {
    return attachRecentsToHome({ source: 'supabase', cards: [], sections: {} }, recentIds);
  }

  const byId = new Map();
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
      if (!tilePricePkn(next) && tilePricePkn(prev)) {
        merged.price = prev.price;
        merged.lowest_price_pkn = prev.lowest_price_pkn;
      }
      byId.set(id, applyTilePrice(merged));
    }
  }
  for (const rail of rails) {
    remember(rail.cards);
  }

  const idsOf = (rail, n) => asCards(rail?.cards).map(cardId).filter(Boolean).slice(0, n);

  return attachRecentsToHome({
    source: 'supabase',
    cards: [...byId.values()],
    sections: {
      newArrivalIds: idsOf(newCards, 12),
      featuredIds: idsOf(featured, 12),
      bestSellerIds: idsOf(bestSellers, 12),
      spotlightIds: idsOf(spotlight, 16),
      topSoldIds: idsOf(topSold, 24),
    },
  }, recentIds);
}

export async function fetchSetIndexFromLists() {
  const rail = await fetchRail(RAIL.setIndex);
  if (!rail) {
    return null;
  }
  const expansions = rail.meta?.expansions || rail.cards;
  if (!Array.isArray(expansions) || !expansions.length) {
    return null;
  }
  return { expansions, source: 'supabase' };
}

export async function fetchExpansionFromLists({ slug = '', limit = 48, offset = 0 } = {}) {
  if (Number(offset) > 0) {
    return null;
  }
  const rail = await fetchRail(setRailId(slug));
  if (!rail?.cards?.length) {
    return null;
  }
  const cards = (rail.cards || []).slice(0, Number(limit) || 48).map(applyTilePrice);
  const expansion = rail.meta?.expansion || { slug, name: rail.meta?.name || slug };
  const cardCount = Number(expansion.cardCount || rail.meta?.cardCount || rail.meta?.total || 0);
  return {
    source: 'supabase',
    cards,
    expansion: cardCount > 0 ? { ...expansion, cardCount } : expansion,
    expansions: [],
    hasMore: Boolean(rail.meta?.hasMore),
    limit: Number(limit) || 48,
    offset: 0,
    ...(cardCount > 0 ? { total: cardCount } : {}),
  };
}
