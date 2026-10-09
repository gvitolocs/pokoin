// What a drop on the header Cart tray adds: one card (cheapest listing), a
// listing, a multi-select pile, or a whole Pokémon / artist / set bundle.
// No React — the React and Solid CartDrop share it.

import { fetchArtist, fetchExpansionCards, fetchListings } from './api.js';
import { addCatalogCards } from './cart-add.js';
import { pickCartOffer } from './cart-offer.js';
import { cartItemFromOffer } from './cart-rows.js';
import { bundleOf } from './chat-listing.js';
import { fetchSpeciesCards } from './species-cards.js';

const BUNDLE_MAX = 400;

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

export async function addDraggedGroup(rows, onAdd) {
  const listings = [];
  const catalog = [];
  for (const row of rows || []) {
    if (row?.kind === 'listing' && row.listingId) listings.push(row);
    else if (row?.cardId || row?.id) catalog.push(row);
  }
  for (const row of listings) {
    await addDraggedCard(row, onAdd);
  }
  if (catalog.length) await addCatalogCards(catalog, onAdd);
}

export async function addBundle(reference, onAdd) {
  const bundle = bundleOf(reference);
  if (!bundle?.slug) return;
  const cards = bundle.kind === 'artist'
    ? (await fetchArtist(bundle.slug, { limit: 6000 }).catch(() => null))?.cards || []
    : bundle.kind === 'species'
      ? await fetchSpeciesCards(decodeURIComponent(bundle.slug)).catch(() => [])
      : (await fetchExpansionCards({ slug: bundle.slug }).catch(() => null))?.cards || [];
  // Listed printings first; the cart holds BUNDLE_MAX lines anyway.
  const queue = [...cards]
    .sort((a, b) => Number(hasListingSignal(b)) - Number(hasListingSignal(a)))
    .slice(0, BUNDLE_MAX);
  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const card = queue[cursor];
      cursor += 1;
      const shaped = catalogCard(card, reference.cardName);
      if (!shaped.id) continue;
      const listed = await fetchListings(shaped.id, { limit: 40 }).catch(() => null);
      const offer = pickCartOffer(listed?.listings || []);
      if (offer) found.push(cartItemFromOffer(shaped, offer));
    }
  }
  const width = Math.min(6, queue.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  // One synchronous burst: the cart renders + writes once instead of
  // hundreds of times while the requests trickle in.
  for (const item of found) onAdd(item);
}

function hasListingSignal(card) {
  return Number(card?.listed_quantity || card?.listedQuantity || 0) > 0
    || Number(card?.lowest_price_pkn || card?.pricePkn || 0) > 0;
}

export async function addDraggedCard(reference, onAdd) {
  if (reference.kind === 'listing' && reference.listingId && Number(reference.pricePkn) > 0) {
    onAdd(cartItemFromOffer(
      { id: reference.cardId, name: reference.cardName, canonicalPath: reference.path, imageUrl: reference.imageUrl },
      {
        id: reference.listingId,
        pricePkn: reference.pricePkn,
        sellerUid: reference.sellerUid,
        sellerName: reference.sellerName || reference.seller,
        sellerCountry: reference.sellerCountry || '',
        cardImageUrl: reference.imageUrl,
        condition: reference.condition || 'NM',
        language: reference.language || '',
        reverse: reference.reverse,
        firstEdition: reference.firstEdition,
        graded: reference.graded,
        grade: reference.grade,
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
    { ...offer, qty: reference.qty },
  ));
}

/** The whole drop: a pile, a bundle, or one card / listing. */
export function addCartDrop(reference, onAdd) {
  if (!reference) return undefined;
  if (reference.kind === 'cards') return addDraggedGroup(reference.cards || [], onAdd);
  if (bundleOf(reference)) return addBundle(reference, onAdd);
  if (!reference.cardId) return undefined;
  return addDraggedCard(reference, onAdd);
}
