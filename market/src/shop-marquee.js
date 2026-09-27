/** Rubber-band selection, the same gesture as files on the Windows desktop. */

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
 * Shop marquee may start on a shop row / empty shop panel, or on empty page
 * background so a band that covers listings still selects them. Never on
 * art-frame, card tiles, title/set/artist drags, or chrome.
 */
export function marqueeStartAllowed(target) {
  if (!target?.closest) return false;
  if (marqueeBlocked(target)) return false;
  if (target.closest('.shop-panel, .shop-list, .shop-row')) return true;
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
