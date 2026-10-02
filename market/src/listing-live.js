/**
 * Live listing quantity for an open card desk.
 * SSE is enough: the browser only listens. Checkout and PKN/Stripe
 * payment stay request/response and are not painted as paid here.
 */

export function listingLiveUrl(cardId) {
  return `/api/marketplace-live?cardId=${encodeURIComponent(cardId)}`;
}

export function applyListingLive(offers, event) {
  if (!event?.listingId || !Array.isArray(offers)) return offers;
  let changed = false;
  const next = offers.map((row) => {
    if (String(row.id) !== String(event.listingId)) return row;
    const quantity = Number(event.quantityAvailable);
    const status = event.status || row.status;
    if (row.quantityAvailable === quantity && row.status === status) return row;
    changed = true;
    return {
      ...row,
      quantityAvailable: Number.isFinite(quantity) ? quantity : row.quantityAvailable,
      status,
    };
  });
  return changed ? next : offers;
}

export function subscribeListingLive(cardId, onListing) {
  if (!cardId || typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(listingLiveUrl(cardId));
  source.addEventListener('listing', (event) => {
    try {
      onListing(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame */
    }
  });
  return () => source.close();
}
