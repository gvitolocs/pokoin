/** 1 PKN = 0.005 USDT. EUR asks convert as EUR / 0.005 (same helper as Oracle). */

export const PKN_USDT_PRICE = 0.005;
export const DKK_PER_EUR = 7.5;
export const LIST_CURRENCIES = ['PKN', 'EUR', 'USD', 'DKK'];

/** Countries that use EUR (display). Others fall back to EUR until we add more FX. */
const EURO_COUNTRIES = new Set([
  'AT', 'BE', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES', 'HR',
]);

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

/** Buyer display currency from ISO country. DK→DKK, US→USD, eurozone→EUR, else EUR. */
export function currencyForCountry(countryCode = '') {
  const code = String(countryCode || '').trim().toUpperCase();
  if (code === 'DK') return 'DKK';
  if (code === 'US') return 'USD';
  if (EURO_COUNTRIES.has(code)) return 'EUR';
  return 'EUR';
}

/** Browser locale → ISO country when no saved address (da-DK → DK). */
export function countryFromLocale(locale = '') {
  const tag = String(
    locale
    || (typeof navigator !== 'undefined' ? navigator.language : '')
    || '',
  ).trim();
  const region = tag.match(/[-_]([A-Za-z]{2})$/)?.[1];
  if (region) return region.toUpperCase();
  const lang = tag.toLowerCase().split(/[-_]/)[0];
  if (lang === 'da') return 'DK';
  if (lang === 'it') return 'IT';
  if (lang === 'de') return 'DE';
  if (lang === 'fr') return 'FR';
  if (lang === 'es') return 'ES';
  if (lang === 'nl') return 'NL';
  if (lang === 'sv') return 'SE';
  if (lang === 'pt') return 'PT';
  if (lang === 'pl') return 'PL';
  return 'DK';
}

/** Browser locale hint before an address exists (da-DK → DKK). */
export function currencyFromLocale(locale = '') {
  return currencyForCountry(countryFromLocale(locale));
}

/** Fiat label: PKN converted at 1 PKN = €0.005 (DKK via 7.5). */
export function formatFiatFromPkn(pkn, currency = 'EUR') {
  const code = String(currency || 'EUR').trim().toUpperCase();
  const amount = fiatFromPkn(pkn, code);
  if (amount == null) return '';
  if (code === 'DKK') {
    return `${formatPknNumber(amount, { maximumFractionDigits: 2 })} DKK`;
  }
  if (code === 'USD') {
    return `$${formatPknNumber(amount, { maximumFractionDigits: 2 })}`;
  }
  return `€${formatPknNumber(amount, { maximumFractionDigits: 2 })}`;
}

/**
 * Primary local currency from PKN, with PKN source in parentheses.
 * Example (DK): "0.75 DKK (20 PKN)"
 */
export function formatLocalFromPkn(pkn, currency = 'EUR') {
  const fiat = formatFiatFromPkn(pkn, currency);
  const pknLabel = formatPkn(pkn);
  if (!fiat) return pknLabel || '';
  return pknLabel ? `${fiat} (${pknLabel})` : fiat;
}

/** EUR Checkout Session line (cents) → buyer local display. */
export function formatLocalFromEurCents(cents, currency = 'EUR') {
  const eur = (Number(cents) || 0) / 100;
  if (!(eur > 0)) return '';
  const code = String(currency || 'EUR').trim().toUpperCase();
  if (code === 'DKK') {
    return `${formatPknNumber(eur * DKK_PER_EUR, { maximumFractionDigits: 2 })} DKK`;
  }
  if (code === 'USD') {
    return `$${formatPknNumber(eur, { maximumFractionDigits: 2 })}`;
  }
  return `€${formatPknNumber(eur, { maximumFractionDigits: 2 })}`;
}

/** @deprecated prefer formatLocalFromPkn with currencyForCountry */
export function formatEurAndDkkFromPkn(pkn) {
  return formatLocalFromPkn(pkn, 'DKK');
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
  if (code === 'DKK') return eur * DKK_PER_EUR;
  if (code === 'USD') return eur;
  return eur;
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
