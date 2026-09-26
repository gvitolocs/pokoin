import { useState } from 'react';
import { fetchArtist, fetchExpansionCards, fetchListings } from '../api.js';
import { pickCartOffer } from '../cart-offer.js';
import { cartItemFromOffer } from '../cart.jsx';
import { bundleOf, LISTING_DRAG_TYPE, readListingDrag } from '../chat-listing.js';

export default function CartDrop({ onAdd }) {
  const [over, setOver] = useState(false);

  return (
    <div
      className={`cart-drop${over ? ' is-over' : ''}`}
      role="region"
      aria-label="Add to cart"
      onDragOver={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const reference = readListingDrag(event);
        if (!reference) return;
        if (bundleOf(reference)) {
          void addBundle(reference, onAdd);
          return;
        }
        if (!reference.cardId) return;
        void addDraggedCard(reference, onAdd);
      }}
    >
      <strong>Cart</strong>
      <p>Drop a card, an artist, or a set. A card takes the cheapest Near Mint English listing, then the next condition, then another language.</p>
    </div>
  );
}

function catalogCard(card, fallbackName) {
  const id = String(card?.id || card?.card_id || '');
  return {
    id,
    name: card?.name || fallbackName || 'Card',
    canonicalPath: card?.canonicalPath || card?.canonical_path || (id ? `/marketplace/en/cards/${id}` : ''),
    imageUrl: card?.imageUrl || card?.image_url || '',
    gridImageUrl: card?.gridImageUrl || card?.cdn_image_url || '',
    heroImageUrl: card?.heroImageUrl || '',
  };
}

async function addBundle(reference, onAdd) {
  const bundle = bundleOf(reference);
  if (!bundle?.slug) return;
  const cards = bundle.kind === 'artist'
    ? (await fetchArtist(bundle.slug, { limit: 400 }).catch(() => null))?.cards || []
    : (await fetchExpansionCards({ slug: bundle.slug }).catch(() => null))?.cards || [];
  const queue = cards.slice(0, 400);
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const card = queue[cursor];
      cursor += 1;
      const shaped = catalogCard(card, reference.cardName);
      if (!shaped.id) continue;
      const listed = await fetchListings(shaped.id, { limit: 40 }).catch(() => null);
      const offer = pickCartOffer(listed?.listings || []);
      if (offer) onAdd(cartItemFromOffer(shaped, offer));
    }
  }
  const width = Math.min(6, queue.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
}

async function addDraggedCard(reference, onAdd) {
  if (reference.kind === 'listing' && reference.listingId && Number(reference.pricePkn) > 0) {
    onAdd(cartItemFromOffer(
      { id: reference.cardId, name: reference.cardName, canonicalPath: reference.path, imageUrl: reference.imageUrl },
      {
        id: reference.listingId,
        pricePkn: reference.pricePkn,
        sellerUid: reference.sellerUid,
        sellerName: reference.seller,
        cardImageUrl: reference.imageUrl,
        condition: reference.condition || 'NM',
        language: reference.language || '',
        qty: reference.qty,
        quantityAvailable: reference.stock,
      },
    ));
    return;
  }
  const listed = await fetchListings(reference.cardId, { limit: 80 }).catch(() => null);
  const offer = pickCartOffer(listed?.listings || []);
  if (!offer) return;
  onAdd(cartItemFromOffer(
    { id: reference.cardId, name: reference.cardName, canonicalPath: reference.path, imageUrl: reference.imageUrl },
    offer,
  ));
}
