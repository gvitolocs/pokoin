import { framedByChromeExtension, publicApiUrl } from './extension-auth-bridge.js';
import { applyTilePrice, tilePricePkn } from './pkn.js';
import { expandProvisionalCardIds, normalizeRecentCardIds, realPublicCardId, rewriteCanonicalCardPath } from './card-stub.js';
import { isSetDeskCard } from './search-filters.js';
import { isOriginDownError, isOriginDownStatus, noteOriginDown } from './working-page.js';

const RAIL = {
  newCards: 'new_cards',
  featured: 'featured',
  bestSellers: 'best_sellers',
  spotlight: 'spotlight',
  setIndex: 'set_index',
};

export const NEW_CARDS_LIMIT = 20;
export const FEATURED_LIMIT = 30;

export function setRailId(slug) {
  return `set:${String(slug || '').trim()}`;
}

export function listsConfigured() {
  return true;
}

/** Pi rails vector. Reject Flutter hydrate. */
export function isPublicRailsVector(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.source === 'pi') {
    return true;
  }
  const sections = payload.sections || {};
  return Boolean(
    (sections.newArrivalIds || []).length
    && (sections.featuredIds || []).length
    && (sections.bestSellerIds || []).length
  );
}

function asCards(value) {
  if (Array.isArray(value)) {
    return value.filter((card) => card && (card.id || card.card_id));
  }
  return [];
}

function asHomeCards(value) {
  return asCards(value).filter(isSetDeskCard);
}

function cardId(card) {
  return realPublicCardId(String(card?.id || card?.card_id || ''));
}

export function tileHasName(card) {
  return Boolean(String(card?.name || '').trim());
}

function mergeTile(prev, next) {
  if (!prev) {
    return tileHasName(next) ? next : null;
  }
  if (tileHasName(prev) && !tileHasName(next)) {
    const merged = { ...next, ...prev };
    if (tilePricePkn(next) && !tilePricePkn(prev)) {
      merged.price = next.price;
      merged.lowest_price_pkn = next.lowest_price_pkn;
    }
    return applyTilePrice(merged);
  }
  const merged = { ...prev, ...next };
  if (!tilePricePkn(next) && tilePricePkn(prev)) {
    merged.price = prev.price;
    merged.lowest_price_pkn = prev.lowest_price_pkn;
  }
  return applyTilePrice(merged);
}

function collapseTiles(cards) {
  const byId = new Map();
  for (const card of asCards(cards)) {
    const id = cardId(card);
    if (!id) {
      continue;
    }
    const path = rewriteCanonicalCardPath(card.canonicalPath || card.canonical_path, id);
    const next = applyTilePrice({
      ...card,
      id,
      card_id: id,
      canonicalPath: path || card.canonicalPath,
      canonical_path: path || card.canonical_path,
    });
    const merged = mergeTile(byId.get(id), next);
    if (merged) {
      byId.set(id, merged);
    }
  }
  return [...byId.values()];
}

export async function fetchRail(id) {
  if (!id) {
    return null;
  }
  const response = await fetch(publicApiUrl(`/api/marketplace-rails?id=${encodeURIComponent(id)}`), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    if (!framedByChromeExtension() && (isOriginDownStatus(response.status) || isOriginDownError({ message: raw }, response.status, raw))) {
      noteOriginDown();
    }
    return null;
  }
  const row = await response.json();
  if (!row?.id) {
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
  const wanted = expandProvisionalCardIds(normalizeRecentCardIds(ids, 24), 48);
  if (!wanted.length) {
    return [];
  }
  try {
    const response = await fetch(publicApiUrl(`/api/marketplace-card-tiles?ids=${wanted.join(',')}`), {
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const body = await response.json();
      const cards = Array.isArray(body?.cards) ? body.cards : [];
      return collapseTiles(cards);
    }
  } catch (_) {
    /* Pi tiles unavailable */
  }
  return [];
}

export function attachRecentsToHome(payload, recentIds = [], extraCards = []) {
  const ids = normalizeRecentCardIds(recentIds, 24);
  const byId = new Map();
  function remember(cards) {
    for (const card of collapseTiles(cards)) {
      const id = cardId(card);
      if (!id) {
        continue;
      }
      const merged = mergeTile(byId.get(id), card);
      if (merged) {
        byId.set(id, merged);
      }
    }
  }
  remember(payload?.cards);
  remember(extraCards);
  const missingRecentIds = ids.filter((id) => !byId.has(id));
  return {
    ...payload,
    source: payload?.source || 'pi',
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
  const [newCards, featured, bestSellers, spotlight] = await Promise.all([
    fetchRail(RAIL.newCards),
    fetchRail(RAIL.featured),
    fetchRail(RAIL.bestSellers),
    fetchRail(RAIL.spotlight),
  ]);
  const rails = [newCards, featured, bestSellers, spotlight].filter(Boolean);
  if (!rails.length) {
    return attachRecentsToHome({ source: 'pi', cards: [], sections: {} }, recentIds);
  }

  const byId = new Map();
  for (const rail of rails) {
    for (const card of collapseTiles(asHomeCards(rail.cards))) {
      const id = cardId(card);
      const merged = mergeTile(byId.get(id), card);
      if (merged) {
        byId.set(id, merged);
      }
    }
  }

  const idsOf = (rail, n) => asHomeCards(rail?.cards).map(cardId).filter(Boolean).slice(0, n);

  return attachRecentsToHome({
    source: 'pi',
    cards: [...byId.values()],
    sections: {
      newArrivalIds: idsOf(newCards, NEW_CARDS_LIMIT),
      featuredIds: idsOf(featured, FEATURED_LIMIT),
      bestSellerIds: idsOf(bestSellers, 12),
      spotlightIds: idsOf(spotlight, 16),
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
  return { expansions, source: 'pi' };
}

export function sliceExpansionRail(cards, { limit = 48, offset = 0, cardCount = 0, hasMoreMeta = false } = {}) {
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Number(limit) || 48);
  const rows = (cards || []).slice(start, start + size);
  const total = Number(cardCount) || 0;
  const loaded = start + rows.length;
  const hasMore = total > 0 ? loaded < total : Boolean(hasMoreMeta) || (rows.length >= size && start + rows.length < (cards || []).length);
  return { cards: rows, hasMore, offset: start, limit: size };
}

export async function fetchExpansionFromLists({ slug = '', limit = 48, offset = 0 } = {}) {
  const rail = await fetchRail(setRailId(slug));
  if (!rail?.cards?.length) {
    return null;
  }
  const expansion = rail.meta?.expansion || { slug, name: rail.meta?.name || slug };
  const cardCount = Number(expansion.cardCount || rail.meta?.cardCount || rail.meta?.total || 0);
  const sliced = sliceExpansionRail(rail.cards, {
    limit,
    offset,
    cardCount,
    hasMoreMeta: Boolean(rail.meta?.hasMore),
  });
  if (!sliced.cards.length) {
    return null;
  }
  const cards = sliced.cards.map(applyTilePrice);
  return {
    source: 'pi',
    cards,
    expansion: cardCount > 0 ? { ...expansion, cardCount } : expansion,
    expansions: [],
    hasMore: sliced.hasMore,
    limit: sliced.limit,
    offset: sliced.offset,
    ...(cardCount > 0 ? { total: cardCount } : {}),
  };
}
