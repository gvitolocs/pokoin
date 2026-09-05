/** 1 PKN = 0.005 USDT. EUR asks convert as EUR / 0.005 (same helper as Oracle). */

export const PKN_USDT_PRICE = 0.005;

export function pknFromEur(eur) {
  const amount = Number(eur);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount / PKN_USDT_PRICE;
}

export function tilePricePkn(card) {
  if (!card || typeof card !== 'object') {
    return null;
  }
  for (const key of ['price', 'lowest_price_pkn', 'pricePkn', 'cheapestPricePkn']) {
    const amount = Number(card[key]);
    if (Number.isFinite(amount) && amount > 0) {
      return amount;
    }
  }
  return pknFromEur(card.medianSoldEur ?? card.median_sold_eur);
}

export function applyTilePrice(card) {
  const price = tilePricePkn(card);
  if (price == null) {
    return card;
  }
  return { ...card, price, lowest_price_pkn: price };
}
