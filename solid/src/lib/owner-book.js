import { fetchSellerListings, fetchSellerListingsStamp } from '@market/api.js';
import { inventoryBooks } from '@market/inventory-book.js';
import { getBearer } from '../stores/auth.js';

/**
 * The signed-in seller's book for one game (MyPokoin, its Collection tab, the
 * dashboard): stored rows paint at once, `stamp=1` revalidates, and the whole
 * book is read dearest first (MyPokoin opens on price high → low), so every
 * page stores the same row order. `onUpdate(rows, complete)`.
 */
export function loadOwnerBook(uid, gameId, onUpdate, { force = false } = {}) {
  return inventoryBooks.load(uid, gameId, {
    force,
    fetchPage: async (page) => fetchSellerListings(uid, await getBearer(), { ...page, game: gameId, order: 'price-desc' }),
    fetchStamp: async () => fetchSellerListingsStamp(uid, await getBearer(), { game: gameId }),
    onUpdate,
  });
}
