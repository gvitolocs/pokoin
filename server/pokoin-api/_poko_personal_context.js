'use strict';

/**
 * Build a compact personal marketplace snapshot for Poko intent.
 * Server sources: recents, inventory listings, collection summary, synced
 * cart/watchlist/desk. Client may overlay fresh cart/watchlist/desk on sync.
 */

const RECENT_LIMIT = 12;
const WATCH_LIMIT = 24;
const CART_LIMIT = 24;
const INVENTORY_SAMPLE = 12;
const NAME_HYDRATE_LIMIT = 40;

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseCardId(value) {
  const n = Number(String(value || '').trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeCardIds(values, limit = WATCH_LIMIT) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = parseCardId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanCartItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, CART_LIMIT).map((row) => {
    const cardId = parseCardId(row?.cardId || row?.card_id || row?.card?.id);
    const qty = Math.max(0, Math.min(99, Math.trunc(Number(row?.qty) || 0)));
    const pricePkn = Math.max(0, Math.trunc(Number(row?.pricePkn ?? row?.price_pkn) || 0));
    if (!cardId || qty < 1) return null;
    return {
      cardId: String(cardId),
      name: cleanText(row?.name || row?.cardName || row?.card?.name, 120) || `card ${cardId}`,
      qty,
      pricePkn,
      sellerName: cleanText(row?.sellerName || row?.seller_name, 80),
      condition: cleanText(row?.condition, 20),
      language: cleanText(row?.language, 12),
    };
  }).filter(Boolean);
}

function cleanDesk(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cardId = parseCardId(src.cardId || src.deskCardId || src.desk_card_id);
  if (!cardId && !src.name && !src.deskCardName) return null;
  return {
    cardId: cardId ? String(cardId) : '',
    name: cleanText(src.name || src.deskCardName || src.desk_card_name, 120),
    setName: cleanText(src.setName || src.deskSetName || src.desk_set_name, 120),
  };
}

function isUndefinedTable(error) {
  return error?.code === '42P01' || /does not exist/i.test(String(error?.message || ''));
}

async function hydrateCardLabels(query, ids) {
  const wanted = normalizeCardIds(ids, NAME_HYDRATE_LIMIT);
  if (!wanted.length || typeof query !== 'function') return new Map();
  try {
    const result = await query(
      `select card_id::text as id, name, set_name
         from marketplace_search_candidates
        where card_id = any($1::bigint[])`,
      [wanted],
    );
    const map = new Map();
    for (const row of result?.rows || []) {
      map.set(String(row.id), {
        cardId: String(row.id),
        name: cleanText(row.name, 120),
        setName: cleanText(row.set_name, 120),
      });
    }
    return map;
  } catch (error) {
    if (isUndefinedTable(error)) return new Map();
    throw error;
  }
}

function labelCards(ids, labels) {
  return normalizeCardIds(ids, NAME_HYDRATE_LIMIT).map((id) => {
    const hit = labels.get(String(id));
    return hit || { cardId: String(id), name: '', setName: '' };
  });
}

async function readRecents(query, uid) {
  try {
    const result = await query(
      `select card_ids
         from public.marketplace_user_recents
        where user_uid = $1
          and game = 'pokemon'
        limit 1`,
      [uid],
    );
    return normalizeCardIds(result?.rows?.[0]?.card_ids || [], RECENT_LIMIT);
  } catch (error) {
    if (isUndefinedTable(error) || error?.code === '42703') return [];
    throw error;
  }
}

async function readInventory(query, uid) {
  try {
    const summary = await query(
      `select count(*)::int as listing_count,
              coalesce(sum(quantity_available), 0)::int as quantity
         from public.marketplace_user_listings
        where seller_uid = $1
          and status in ('active', 'paused')
          and quantity_available > 0`,
      [uid],
    );
    const samples = await query(
      `select card_id::text as card_id, card_name, set_name, quantity_available,
              price_pkn, condition, language, status
         from public.marketplace_user_listings
        where seller_uid = $1
          and status in ('active', 'paused')
          and quantity_available > 0
        order by updated_at desc nulls last, created_at desc nulls last
        limit $2`,
      [uid, INVENTORY_SAMPLE],
    );
    const row = summary?.rows?.[0] || {};
    return {
      listingCount: Number(row.listing_count) || 0,
      quantity: Number(row.quantity) || 0,
      samples: (samples?.rows || []).map((item) => ({
        cardId: cleanText(item.card_id, 40),
        name: cleanText(item.card_name, 120),
        setName: cleanText(item.set_name, 120),
        qty: Number(item.quantity_available) || 0,
        pricePkn: Number(item.price_pkn) || 0,
        condition: cleanText(item.condition, 20),
        language: cleanText(item.language, 12),
        status: cleanText(item.status, 20),
      })),
    };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { listingCount: 0, quantity: 0, samples: [] };
    }
    throw error;
  }
}

async function readCollectionSummary({ firestore, uid, summarizeOwnedCollection }) {
  if (!firestore || typeof summarizeOwnedCollection !== 'function') {
    return { cardsOwned: 0, items: 0, physicalOwned: 0, nftOwned: 0 };
  }
  try {
    const summary = await summarizeOwnedCollection({ firestore, uid });
    return {
      cardsOwned: Number(summary?.cardsOwned) || 0,
      items: Number(summary?.items) || 0,
      physicalOwned: Number(summary?.physicalOwned) || 0,
      nftOwned: Number(summary?.nftOwned) || 0,
    };
  } catch (error) {
    console.warn('poko personal collection summary failed', String(error?.message || error).slice(0, 160));
    return { cardsOwned: 0, items: 0, physicalOwned: 0, nftOwned: 0 };
  }
}

async function readSnapshot(query, uid) {
  try {
    const result = await query(
      `select watchlist_card_ids, cart_items, desk_card_id, desk_card_name, desk_set_name, updated_at
         from public.poko_user_personal_snapshot
        where firebase_uid = $1
        limit 1`,
      [uid],
    );
    const row = result?.rows?.[0];
    if (!row) {
      return {
        watchlistIds: [],
        cart: [],
        desk: null,
        updatedAt: null,
      };
    }
    return {
      watchlistIds: normalizeCardIds(row.watchlist_card_ids || [], WATCH_LIMIT),
      cart: cleanCartItems(row.cart_items),
      desk: cleanDesk({
        cardId: row.desk_card_id,
        name: row.desk_card_name,
        setName: row.desk_set_name,
      }),
      updatedAt: row.updated_at || null,
    };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { watchlistIds: [], cart: [], desk: null, updatedAt: null };
    }
    throw error;
  }
}

async function writeSnapshot(writeQuery, uid, { watchlistIds, cart, desk }) {
  const ids = normalizeCardIds(watchlistIds, WATCH_LIMIT);
  const items = cleanCartItems(cart);
  const deskRow = cleanDesk(desk);
  await writeQuery(
    `insert into public.poko_user_personal_snapshot
       (firebase_uid, watchlist_card_ids, cart_items, desk_card_id, desk_card_name, desk_set_name, updated_at)
     values ($1, $2::bigint[], $3::jsonb, $4, $5, $6, now())
     on conflict (firebase_uid) do update
       set watchlist_card_ids = excluded.watchlist_card_ids,
           cart_items = excluded.cart_items,
           desk_card_id = excluded.desk_card_id,
           desk_card_name = excluded.desk_card_name,
           desk_set_name = excluded.desk_set_name,
           updated_at = now()`,
    [
      uid,
      ids,
      JSON.stringify(items),
      deskRow?.cardId ? Number(deskRow.cardId) : null,
      deskRow?.name || null,
      deskRow?.setName || null,
    ],
  );
  return { watchlistIds: ids, cart: items, desk: deskRow };
}

/**
 * @param {object} opts
 * @param {function} opts.query marketplaceQuery
 * @param {function} [opts.writeQuery] marketplaceWriteQuery (required for sync)
 * @param {string} opts.uid firebase uid
 * @param {object} [opts.firestore]
 * @param {function} [opts.summarizeOwnedCollection]
 * @param {object} [opts.overlay] client cart/watchlist/desk for this turn
 * @param {boolean} [opts.persistOverlay] write overlay into snapshot
 */
async function buildPersonalContext({
  query,
  writeQuery,
  uid,
  firestore = null,
  summarizeOwnedCollection = null,
  overlay = {},
  persistOverlay = false,
} = {}) {
  const userId = cleanText(uid, 160);
  if (!userId) {
    const error = new Error('Missing Pokoin user.');
    error.statusCode = 401;
    throw error;
  }

  const stored = await readSnapshot(query, userId);
  const overlayWatch = Array.isArray(overlay.watchlistIds) || Array.isArray(overlay.watchlist)
    ? normalizeCardIds(overlay.watchlistIds || overlay.watchlist, WATCH_LIMIT)
    : null;
  const overlayCart = overlay.cart != null ? cleanCartItems(overlay.cart) : null;
  const overlayDesk = overlay.desk != null || overlay.deskCardId
    ? cleanDesk(overlay.desk || overlay)
    : null;

  const watchlistIds = overlayWatch != null ? overlayWatch : stored.watchlistIds;
  const cart = overlayCart != null ? overlayCart : stored.cart;
  const desk = overlayDesk != null ? overlayDesk : stored.desk;

  if (persistOverlay && typeof writeQuery === 'function'
    && (overlayWatch != null || overlayCart != null || overlayDesk != null)) {
    await writeSnapshot(writeQuery, userId, { watchlistIds, cart, desk }).catch((error) => {
      if (!isUndefinedTable(error)) throw error;
    });
  }

  const [recentIds, inventory, collection] = await Promise.all([
    readRecents(query, userId),
    readInventory(query, userId),
    readCollectionSummary({ firestore, uid: userId, summarizeOwnedCollection }),
  ]);

  const labelIds = [
    ...recentIds,
    ...watchlistIds,
    ...cart.map((row) => row.cardId),
    desk?.cardId,
  ].filter(Boolean);
  const labels = await hydrateCardLabels(query, labelIds);

  const cartLabeled = cart.map((row) => {
    const hit = labels.get(String(row.cardId));
    return {
      ...row,
      name: row.name || hit?.name || `card ${row.cardId}`,
      setName: hit?.setName || '',
    };
  });

  let deskOut = desk;
  if (deskOut?.cardId && (!deskOut.name || !deskOut.setName)) {
    const hit = labels.get(String(deskOut.cardId));
    if (hit) {
      deskOut = {
        cardId: deskOut.cardId,
        name: deskOut.name || hit.name,
        setName: deskOut.setName || hit.setName,
      };
    }
  }

  return {
    desk: deskOut,
    recents: labelCards(recentIds, labels),
    watchlist: labelCards(watchlistIds, labels),
    cart: cartLabeled,
    inventory,
    collection,
    syncedAt: stored.updatedAt,
  };
}

/** Compact intent block for Hermes planner / reply memory. */
function formatPersonalIntent(personal) {
  if (!personal || typeof personal !== 'object') return '';
  const lines = ['Personal marketplace context (verified Pokoin account — personalize; never invent ownership):'];
  if (personal.desk?.cardId || personal.desk?.name) {
    const bits = [
      personal.desk.name || 'card',
      personal.desk.setName ? `(${personal.desk.setName})` : '',
      personal.desk.cardId ? `cardId=${personal.desk.cardId}` : '',
    ].filter(Boolean);
    lines.push(`- Open desk: ${bits.join(' ')}`);
  }
  if (personal.recents?.length) {
    lines.push(`- Recently seen (${personal.recents.length}): ${personal.recents.slice(0, 8).map((row) => {
      return row.name ? `${row.name}${row.setName ? ` [${row.setName}]` : ''}#${row.cardId}` : `#${row.cardId}`;
    }).join('; ')}`);
  }
  if (personal.watchlist?.length) {
    lines.push(`- Watchlist (${personal.watchlist.length}): ${personal.watchlist.slice(0, 8).map((row) => {
      return row.name ? `${row.name}#${row.cardId}` : `#${row.cardId}`;
    }).join('; ')}`);
  }
  if (personal.cart?.length) {
    const total = personal.cart.reduce((sum, row) => sum + (row.pricePkn || 0) * (row.qty || 0), 0);
    lines.push(`- Cart (${personal.cart.length} lines, ~${total} PKN): ${personal.cart.slice(0, 8).map((row) => {
      return `${row.name || row.cardId}×${row.qty}${row.pricePkn ? `@${row.pricePkn}` : ''}`;
    }).join('; ')}`);
  }
  if (personal.inventory && (personal.inventory.listingCount > 0 || personal.inventory.quantity > 0)) {
    const samples = (personal.inventory.samples || []).slice(0, 6).map((row) => {
      return `${row.name || row.cardId}×${row.qty}${row.pricePkn ? `@${row.pricePkn}PKN` : ''}`;
    }).join('; ');
    lines.push(
      `- Selling inventory: ${personal.inventory.listingCount} listings / ${personal.inventory.quantity} qty`
        + (samples ? ` — ${samples}` : ''),
    );
  }
  if (personal.collection && (personal.collection.cardsOwned > 0 || personal.collection.items > 0)) {
    lines.push(
      `- Collection: ${personal.collection.cardsOwned} cards owned`
        + ` (${personal.collection.physicalOwned || 0} physical, ${personal.collection.nftOwned || 0} NFT)`,
    );
  }
  if (lines.length === 1) return '';
  lines.push('- Prefer these facts when the user says "my cart", "my watchlist", "what I was looking at", or "my stock".');
  return lines.join('\n');
}

module.exports = {
  buildPersonalContext,
  formatPersonalIntent,
  cleanCartItems,
  cleanDesk,
  normalizeCardIds,
  parseCardId,
  _test: {
    cleanCartItems,
    cleanDesk,
    normalizeCardIds,
    parseCardId,
    formatPersonalIntent,
    labelCards,
    isUndefinedTable,
  },
};
