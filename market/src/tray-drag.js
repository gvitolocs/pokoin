/**
 * Tray card drag: start from cart / desktop / message drafts; drop elsewhere
 * (or outside) removes from the source tray. Dropping back on the same tray
 * keeps the card.
 */

import { cardReference, LISTING_DRAG_TYPE, listingReference, writeListingDrag } from './chat-listing.js';

export const TRAY_CART = 'cart';
export const TRAY_DESKTOP = 'desktop';
export const TRAY_MESSAGES = 'messages';

export const TRAY_SOURCE_TYPE = 'application/x-pokoin-tray-source';

/** Draft attachments are keyed per conversation so a move between threads removes the source. */
export function messagesTrayId(peer) {
  const id = String(peer || 'poko').trim() || 'poko';
  return `${TRAY_MESSAGES}:${id}`;
}

let session = null;

/** Listing reference for a cart line so Messages / Desktop can accept it. */
export function cartItemReference(row) {
  if (!row) return null;
  const cardId = String(row.cardId || row.card?.id || '');
  if (!cardId && !row.listingId && !row.id) return null;
  return listingReference({
    offer: {
      id: row.listingId || row.id,
      pricePkn: row.pricePkn,
      sellerUid: row.sellerUid,
      sellerName: row.sellerName,
      sellerCountry: row.sellerCountry,
      condition: row.condition,
      language: row.language,
      qty: row.qty,
      quantityAvailable: row.stock,
    },
    card: {
      id: cardId || row.id,
      name: row.name || row.card?.name || 'Card',
      canonicalPath: row.href || '',
      imageUrl: row.image || '',
    },
    qty: row.qty,
  });
}

/** Catalog-style reference for a Desktop hold row. */
export function desktopItemReference(row) {
  if (!row?.id && !row?.cardId) return null;
  const ref = cardReference({
    id: row.id || row.cardId,
    name: row.name,
    canonicalPath: row.path || '',
    imageUrl: row.imageUrl || row.image || '',
    set: row.setName || row.set || '',
    number: row.number,
    rarity: row.rarity,
    artist: row.artist,
    pricePkn: row.pricePkn,
  });
  const qty = Number(row.qty);
  if (Number.isFinite(qty) && qty > 0) ref.qty = Math.min(99, Math.trunc(qty));
  return ref;
}

/**
 * @param {DragEvent} event
 * @param {{ tray: string, reference: object, remove: () => void }} opts
 */
export function startTrayDrag(event, { tray, reference, remove }) {
  if (!event?.dataTransfer || !reference?.cardName || typeof remove !== 'function') return false;
  const trayId = String(tray || '').trim();
  if (!trayId) return false;
  try {
    writeListingDrag(event, reference);
  } catch (_) {
    // Node tests (and any host without a DOM) still need the listing payload.
    try {
      event.dataTransfer.setData(LISTING_DRAG_TYPE, JSON.stringify(reference));
      event.dataTransfer.setData('text/plain', reference.cardName);
    } catch (_) {
      /* locked types */
    }
  }
  try {
    event.dataTransfer.setData(TRAY_SOURCE_TYPE, trayId);
  } catch (_) {
    /* jsdom / locked types */
  }
  event.dataTransfer.effectAllowed = 'copyMove';
  session = {
    tray: trayId,
    remove,
    dropTray: null,
  };
  return true;
}

/** Call from a drop handler after it accepts the listing. */
export function acceptTrayDrop(tray) {
  if (!session) return;
  const trayId = String(tray || '').trim();
  if (!trayId) return;
  session.dropTray = trayId;
}

/** Call on dragend of the tray source. Removes unless dropped on the same tray. */
export function endTrayDrag() {
  const current = session;
  session = null;
  if (!current?.remove) return false;
  if (current.dropTray && current.dropTray === current.tray) return false;
  try {
    current.remove();
  } catch (_) {
    /* ignore */
  }
  return true;
}

/** Test / teardown helper. */
export function resetTrayDrag() {
  session = null;
}

export function peekTrayDrag() {
  return session ? { tray: session.tray, dropTray: session.dropTray } : null;
}
