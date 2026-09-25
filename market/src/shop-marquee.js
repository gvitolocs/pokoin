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

/** Pressing a row, control, or card starts a drag or a click, not a selection box. */
export function marqueeBlocked(target) {
  return Boolean(target?.closest?.(
    '.shop-row, a, button, input, select, textarea, label, .art-frame, [draggable="true"], .chat-dock, .chat-tag',
  ));
}
