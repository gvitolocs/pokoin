import { fetchListings } from './api.js';
import { cartItemFromOffer } from './cart.jsx';
import { pickCartOffer } from './cart-offer.js';

/** Same cheapest-listing cascade as dropping one card on the cart, for a selected group. */
export async function addCatalogCards(cards, onAdd) {
  const queue = (cards || []).filter((card) => card?.id || card?.cardId).slice(0, 80);
  if (!queue.length || typeof onAdd !== 'function') return 0;
  let cursor = 0;
  let added = 0;
  async function worker() {
    while (cursor < queue.length) {
      const card = queue[cursor];
      cursor += 1;
      const id = String(card.id || card.cardId || '');
      if (!id) continue;
      const shaped = {
        id,
        name: card.name || card.cardName || 'Card',
        canonicalPath: card.canonicalPath || card.path || '',
        imageUrl: card.imageUrl || '',
        gridImageUrl: card.gridImageUrl || '',
        heroImageUrl: card.heroImageUrl || '',
      };
      const listed = await fetchListings(id, { limit: 80 }).catch(() => null);
      const offer = pickCartOffer(listed?.listings || []);
      if (!offer) continue;
      onAdd(cartItemFromOffer(shaped, offer));
      added += 1;
    }
  }
  const width = Math.min(6, queue.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return added;
}
