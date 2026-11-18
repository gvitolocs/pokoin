import { gamePrices, priceCheckKey } from '@market/inventory-price.js';

// Market comps of the rows on screen outlive a remount (tab switch, back
// from a card desk): the column paints with the board instead of "…".
const PRICE_MEMO_MS = 10 * 60_000;
const priceMemo = new Map();

/** The price checks remembered under `key` (source + request), if still fresh. */
export function memoPrices(key) {
  const hit = priceMemo.get(key);
  return hit && Date.now() - hit.at < PRICE_MEMO_MS ? hit.prices : null;
}

export function rememberPrices(key, prices) {
  priceMemo.delete(key);
  priceMemo.set(key, { prices, at: Date.now() });
  while (priceMemo.size > 24) priceMemo.delete(priceMemo.keys().next().value);
}

/**
 * The comp of `row` from any price check the board already loaded for its
 * market column (newest first), or null. Never asks the server.
 */
export function rememberedComp(row, gameId) {
  const now = Date.now();
  for (const hit of [...priceMemo.values()].reverse()) {
    if (now - hit.at >= PRICE_MEMO_MS) continue;
    const prices = gamePrices(hit.prices, row, gameId) || {};
    const entry = prices[priceCheckKey(row)] || prices[String(row?.cardId || row?.card_id || '')];
    if (entry) return entry;
  }
  return null;
}
