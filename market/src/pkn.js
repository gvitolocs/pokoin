/** 1 PKN = 0.005 USDT. EUR asks convert as EUR / 0.005 (same helper as Oracle). */

export const PKN_USDT_PRICE = 0.005;
export const DKK_PER_EUR = 7.5;
export const LIST_CURRENCIES = ['PKN', 'EUR', 'USD', 'DKK'];

export function parseListAmount(value) {
  if (typeof value === 'number') {
    return value;
  }
  return Number(String(value || '').replace(/,/g, '').trim());
}

/** Digits only. A thousands comma looks like a decimal in EU locales (2642 not 2,642). */
export function formatPknNumber(value, { maximumFractionDigits = 2 } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '0';
  }
  return amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits });
}

export function formatPkn(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return '';
  }
  return `${formatPknNumber(amount)} PKN`;
}

export function pknFromEur(eur) {
  const amount = parseListAmount(eur);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount / PKN_USDT_PRICE;
}

export function fiatFromPkn(pkn, currency = 'PKN') {
  const amount = parseListAmount(pkn);
  const code = String(currency || 'PKN').trim().toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (code === 'PKN') {
    return amount;
  }
  const eur = amount * PKN_USDT_PRICE;
  return code === 'DKK' ? eur * DKK_PER_EUR : eur;
}

export function listingPriceToPkn(amount, currency = 'PKN') {
  const value = parseListAmount(amount);
  const code = String(currency || 'PKN').trim().toUpperCase();
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (code === 'PKN') {
    return value;
  }
  const eur = code === 'DKK' ? value / DKK_PER_EUR : value;
  return Math.round((eur / PKN_USDT_PRICE) * 100) / 100;
}

export function listPriceHint(pkn, currency = 'PKN') {
  const converted = fiatFromPkn(pkn, currency);
  if (converted == null) {
    return '';
  }
  if (String(currency || 'PKN').toUpperCase() === 'PKN') {
    return String(converted);
  }
  return String(Number(converted.toFixed(2)));
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

export function lastMedianMapFromBatch(data) {
  const byId = {};
  for (const row of data?.prices || []) {
    const id = String(row?.card_id || row?.cardId || '').trim();
    const pkn = Number(row?.median_pkn ?? row?.lastMedianPkn);
    if (/^\d+$/.test(id) && Number.isFinite(pkn) && pkn > 0) {
      byId[id] = pkn;
    }
  }
  return byId;
}

export function lastMedianFromSales(data) {
  const pkn = Number(data?.series?.lastMedianPkn);
  return Number.isFinite(pkn) && pkn > 0 ? pkn : null;
}

export function applyLastMedianPrices(cards, medians = {}) {
  return (cards || []).map((card) => {
    const pkn = Number(medians[String(card?.id || '')]);
    if (!Number.isFinite(pkn) || pkn <= 0) {
      return card;
    }
    return applyTilePrice({
      ...card,
      price: pkn,
      lowest_price_pkn: pkn,
      lastMedianPkn: pkn,
    });
  });
}

export function idsMissingTilePrice(cards) {
  const ids = [];
  const seen = new Set();
  for (const card of cards || []) {
    const id = String(card?.id || '').trim();
    if (!/^\d+$/.test(id) || seen.has(id) || tilePricePkn(card) != null) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
