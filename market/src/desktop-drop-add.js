// What a drop on the header Desktop tray parks: a pile, a set logo, every
// printing of an artist or Pokémon, or one card. No React — the React and
// Solid DesktopDrop share it.

import { fetchArtist } from './api.js';
import { bundleOf } from './chat-listing.js';
import {
  addDesktopCards,
  DESKTOP_MAX,
  desktopHoldMemoryOnly,
  readDesktopHold,
} from './desktop-hold.js';
import { fetchSpeciesCards } from './species-cards.js';

export async function addDesktopDrop(reference) {
  if (!reference) return;
  if (reference.kind === 'cards') {
    addDesktopCards((reference.cards || []).map((row) => ({
      id: row.cardId || row.id,
      name: row.cardName || row.name,
      imageUrl: row.imageUrl,
      path: row.path,
      set: row.setName,
      setName: row.setName,
      number: row.number,
      rarity: row.rarity,
      artist: row.artist,
      pricePkn: row.pricePkn,
      qty: row.qty,
      stock: row.stock,
    })));
    return;
  }
  const bundle = bundleOf(reference);
  if (bundle?.slug) {
    // Expansion drops park the set logo only — not every card in the set.
    if (bundle.kind === 'expansion') {
      addDesktopCards([{
        id: `expansion:${bundle.slug}`,
        name: reference.cardName,
        imageUrl: reference.imageUrl,
        path: reference.path || `/marketplace/sets/${bundle.slug}`,
        set: reference.setName || reference.cardName,
        setName: reference.setName || reference.cardName,
      }]);
      return;
    }
    const cards = bundle.kind === 'artist'
      ? (await fetchArtist(bundle.slug, { limit: DESKTOP_MAX }).catch(() => null))?.cards || []
      : await fetchSpeciesCards(decodeURIComponent(bundle.slug)).catch(() => []);
    addDesktopCards(cards);
    return;
  }
  if (!reference.cardId) return;
  addDesktopCards([{
    id: reference.cardId,
    name: reference.cardName,
    imageUrl: reference.imageUrl,
    path: reference.path,
    set: reference.setName,
    setName: reference.setName,
    number: reference.number,
    rarity: reference.rarity,
    artist: reference.artist,
    pricePkn: reference.pricePkn,
    qty: reference.qty,
    stock: reference.stock,
  }]);
}

/** The tray note after a drop when storage or the cap stopped it ('' otherwise). */
export function desktopCapacityNote() {
  if (desktopHoldMemoryOnly()) {
    return 'Browser storage is full: the desktop is kept until you close this tab.';
  }
  if (readDesktopHold().length >= DESKTOP_MAX) {
    return `Desktop is full (${DESKTOP_MAX} cards).`;
  }
  return '';
}
