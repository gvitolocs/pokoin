/** Rubber-band selection, the same gesture as files on the Windows desktop. */

import { cardReference, listingReference, listingsReference } from './chat-listing.js';

export function marqueeRect(x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Rubber-band in viewport space after the page has scrolled since pointer-down.
 * Origin is remembered in client coords + scroll; as the document moves, the
 * origin point drifts on screen so the box covers rows that scrolled under it
 * (Windows Explorer / Finder behaviour). Without this, a fixed client-space
 * box stays glued to the viewport and only hits currently-visible rows.
 */
export function marqueeRectForScroll(origin, clientX, clientY, scrollX = 0, scrollY = 0) {
  if (!origin) return marqueeRect(clientX, clientY, clientX, clientY);
  const dx = Number(scrollX) - Number(origin.scrollX || 0);
  const dy = Number(scrollY) - Number(origin.scrollY || 0);
  return marqueeRect(
    Number(origin.x) - dx,
    Number(origin.y) - dy,
    Number(clientX),
    Number(clientY),
  );
}

export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function listingSelectId(offer) {
  if (offer?.id) return String(offer.id);
  return [offer?.sellerName || offer?.sellerUsername || '', offer?.pricePkn || 0, offer?.cardName || offer?.name || ''].join('|');
}

/** Buttons and fields keep their own click. The card scan can start a selection box. */
export function marqueeBlocked(target) {
  return Boolean(target?.closest?.(
    'button, input, select, textarea, label, .ct-qty, .shop-row-actions, .chat-dock, .chat-tag',
  ));
}

/**
 * Shop marquee starts only on empty page background (outside the shop panel
 * and its rows). Listings keep click → card overlay, drag, and controls.
 */
export function marqueeStartAllowed(target) {
  if (!target?.closest) return false;
  if (marqueeBlocked(target)) return false;
  if (target.closest('.shop-panel, .shop-list, .shop-row')) return false;
  if (target.closest(
    [
      '[data-card-id]',
      '.art-frame',
      '.species-drag',
      '.asset-header',
      '.asset-sub',
      '.asset-title-row',
      'a',
      'button',
      'input',
      'select',
      'textarea',
      'label',
      'header',
      'footer',
      'nav',
      '.topbar',
      '.suggest',
      '.cart-drop',
      '.desktop-drop',
      'dialog',
      '.chat-dock',
    ].join(', '),
  )) {
    return false;
  }
  return Boolean(target.closest('main'));
}

/**
 * Rubber-band multi-select is desktop mouse only. Touch / phone tap-hold must
 * not arm a selection box (scroll and long-press stay native).
 * Account / static pages keep Chrome text selection and copy.
 */
export function selectBandRoute(pathname = '') {
  const path = String(pathname || '');
  if (!path) return false;
  return (
    path.includes('/marketplace')
    || path.startsWith('/mypokoin')
    || path.startsWith('/inventory')
    || path.startsWith('/dashboard')
  );
}

export function selectBandAllowed(event, win = typeof window !== 'undefined' ? window : null) {
  if (event?.pointerType && event.pointerType !== 'mouse') return false;
  if (win?.matchMedia?.('(max-width: 720px)')?.matches) return false;
  if (win?.matchMedia?.('(pointer: coarse)')?.matches) return false;
  const path = win?.location?.pathname || '';
  if (!selectBandRoute(path)) return false;
  return true;
}

/** A plain pointer outside the selected rows dismisses the current group. */
export function clearShopSelectionOnPointer(target, list, selected, event = {}) {
  if (!selected?.size) return false;
  const row = target?.closest?.('.shop-row[data-listing-id]');
  const id = row?.dataset?.listingId || '';
  if (id && selected.has(id)) return false;
  if (row && list?.contains?.(row) && (event.shiftKey || event.ctrlKey || event.metaKey)) {
    return false;
  }
  return true;
}

/** Listings that ride along when a selected shop row is dragged. Held row is first. */
export function shopDragOffers(rows, selected, offer) {
  const id = listingSelectId(offer);
  if (!id || !selected?.has?.(id) || selected.size < 2) return null;
  const mates = (rows || []).filter((row) => selected.has(listingSelectId(row)));
  if (mates.length < 2) return null;
  const rest = mates.filter((row) => listingSelectId(row) !== id);
  return [offer, ...rest];
}

/**
 * Card desk pile: selected shop listings + selected tiles (desk art / related)
 * in one drag. Held item first. Listings keep seller metadata; tiles are cards.
 */
export function mixedDeskDragReference({
  heldOffer = null,
  heldCard = null,
  offers = [],
  catalog = new Map(),
  cardSelected = new Set(),
  listingSelected = new Set(),
  deskCard = null,
} = {}) {
  const rows = [];
  const seenListings = new Set();
  const seenCards = new Set();
  const cards = cardSelected instanceof Set ? cardSelected : new Set([...(cardSelected || [])].map(String));
  const listings = listingSelected instanceof Set
    ? listingSelected
    : new Set([...(listingSelected || [])].map(String));

  function pushListing(offer, cardStub) {
    const id = listingSelectId(offer);
    if (!id || seenListings.has(id)) return;
    seenListings.add(id);
    rows.push(listingReference({
      offer,
      card: cardStub || deskCard || {
        id: offer?.cardId || offer?.card_id,
        name: offer?.cardName || offer?.name,
        canonicalPath: offer?.canonicalPath || offer?.canonical_path,
        imageUrl: offer?.cardImageUrl || offer?.imageUrl || offer?.image_url,
      },
    }));
  }

  function pushCard(card) {
    const id = String(card?.id || card?.cardId || '');
    if (!id || seenCards.has(id)) return;
    seenCards.add(id);
    rows.push(cardReference(card));
  }

  if (heldOffer) {
    pushListing(heldOffer, heldCard || deskCard);
  } else if (heldCard) {
    pushCard(heldCard);
  }

  for (const offer of offers || []) {
    if (!listings.has(listingSelectId(offer))) continue;
    pushListing(offer, deskCard);
  }

  // Prefer catalog order, then any remaining selected ids.
  const orderedIds = [];
  if (typeof document !== 'undefined') {
    for (const node of document.querySelectorAll('main [data-card-id]')) {
      const id = node.getAttribute('data-card-id');
      if (id && cards.has(id) && !orderedIds.includes(id)) orderedIds.push(id);
    }
  }
  for (const id of cards) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  for (const id of orderedIds) {
    const row = catalog.get(String(id));
    if (row) pushCard(row);
  }

  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  return listingsReference(rows);
}
