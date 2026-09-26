export function listingStock(offer) {
  const n = Math.trunc(Number(offer?.quantityAvailable ?? offer?.stock));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

/** Never count more copies than that seller still has. */
export function nextCartQty(currentQty, addQty, stock) {
  const cap = listingStock({ stock });
  const have = Math.max(0, Math.trunc(Number(currentQty) || 0));
  const add = Math.max(1, Math.trunc(Number(addQty) || 1));
  return Math.min(cap, have + add);
}
