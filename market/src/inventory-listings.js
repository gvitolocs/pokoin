/**
 * Seller inventory only surfaces listings that can still appear on a card desk.
 * Cancelled (inactive) and sold-out rows stay in Postgres for history but must
 * not look like live inventory links.
 */

export function isLiveInventoryListing(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || 'active').toLowerCase();
  if (status !== 'active' && status !== 'paused') return false;
  return Number(row.quantityAvailable ?? row.quantity_available ?? 0) > 0;
}

export function liveInventoryListings(rows) {
  return (Array.isArray(rows) ? rows : []).filter(isLiveInventoryListing);
}

/** Card count and summed asking PKN for live inventory rows only. */
export function summarizeLiveInventory(rows) {
  const live = liveInventoryListings(rows);
  let cards = 0;
  let listedPkn = 0;
  for (const row of live) {
    const qty = Math.max(0, Number(row.quantityAvailable ?? row.quantity_available ?? 0) || 0);
    const price = Math.max(0, Number(row.pricePkn ?? row.price_pkn ?? 0) || 0);
    cards += qty;
    listedPkn += price * qty;
  }
  return {
    listings: live.length,
    cards,
    listedPkn,
  };
}

export function inventoryListingHref(row) {
  const path = String(row?.canonicalPath || row?.canonical_path || '').trim();
  if (path.startsWith('/marketplace/')) return path;
  const id = String(row?.cardId || row?.card_id || '').trim();
  if (/^\d+$/.test(id)) return `/marketplace/en/cards/${id}`;
  return '/marketplace';
}

export function inventoryListingMeta(row, formatPkn) {
  const price = typeof formatPkn === 'function'
    ? formatPkn(row?.pricePkn ?? row?.price_pkn)
    : `${row?.pricePkn ?? row?.price_pkn ?? 0} PKN`;
  const parts = [
    price,
    row?.condition || 'NM',
    `qty ${row?.quantityAvailable ?? row?.quantity_available ?? 1}`,
  ];
  const status = String(row?.status || '').toLowerCase();
  if (status === 'paused') parts.push('paused');
  const language = String(row?.language || '').trim().toUpperCase();
  if (language && language !== 'EN') parts.push(language);
  return parts.join(' · ');
}
