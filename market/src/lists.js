/** Read-only marketplace lists on Supabase. Oracle Postgres stays search + source of truth. */

export const SUPABASE_URL = String(
  import.meta.env.VITE_SUPABASE_URL || 'https://ruvtchmbtxvjqmquobij.supabase.co',
).replace(/\/$/, '');

export const SUPABASE_ANON_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '');

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
  if (!listsConfigured() || !wanted.length) {
    return [];
  }
  const rows = await rest(
    `marketplace_card_tiles?card_id=in.(${wanted.join(',')})&select=card_id,payload`,
  );
  return (rows || []).map((row) => row.payload).filter((card) => cardId(card));
}

export async function fetchHomeFromLists(recentIds = []) {
  if (!listsConfigured()) {
    return null;
  }
  const [newCards, featured, bestSellers, spotlight, topSold, recents] = await Promise.all([
    fetchRail(RAIL.newCards),
    fetchRail(RAIL.featured),
    fetchRail(RAIL.bestSellers),
    fetchRail(RAIL.spotlight),
    fetchRail(RAIL.topSold),
    fetchCardTiles(recentIds),
  ]);
  const rails = [newCards, featured, bestSellers, spotlight, topSold].filter(Boolean);
  if (!rails.length && !recents.length) {
    return null;
  }

  const byId = new Map();
  function remember(cards) {
    for (const card of asCards(cards)) {
      const id = cardId(card);
      if (id && !byId.has(id)) {
        byId.set(id, { ...card, id, card_id: card.card_id || id });
      }
    }
  }
  remember(recents);
  for (const rail of rails) {
    remember(rail.cards);
  }

  const idsOf = (rail, n) => asCards(rail?.cards).map(cardId).filter(Boolean).slice(0, n);

  return {
    source: 'supabase',
    cards: [...byId.values()],
    sections: {
      recentlySeenIds: (recentIds || []).map(String).filter((id) => byId.has(id)),
      newArrivalIds: idsOf(newCards, 12),
      featuredIds: idsOf(featured, 12),
      bestSellerIds: idsOf(bestSellers, 12),
      spotlightIds: idsOf(spotlight, 16),
      topSoldIds: idsOf(topSold, 24),
    },
  };
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
  const cards = rail.cards.slice(0, Number(limit) || 48);
  return {
    source: 'supabase',
    cards,
    expansion: rail.meta?.expansion || { slug, name: rail.meta?.name || slug },
    expansions: [],
    hasMore: Boolean(rail.meta?.hasMore),
    limit: Number(limit) || 48,
    offset: 0,
  };
}
