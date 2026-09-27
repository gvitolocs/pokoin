/**
 * Client-side shipping preview from the same seed table the API uses.
 * Server still freezes the real quote — this is display-only.
 */
import ratesCatalog from './shipping-rates.json' with { type: 'json' };

export function packageTierForCount(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n < 1) return '';
  const tiers = [...(ratesCatalog.tiers || [])].sort((a, b) => a.maxCards - b.maxCards);
  return tiers.find((tier) => n <= Number(tier.maxCards))?.id || '';
}

export function findShippingRate({ fromCountry, toCountry, packageTier, catalog = ratesCatalog } = {}) {
  const from = String(fromCountry || '').trim().toUpperCase();
  const to = String(toCountry || '').trim().toUpperCase();
  const tier = String(packageTier || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(from) || !/^[A-Z]{2}$/.test(to) || !tier) return null;
  return (catalog.rates || []).find((rate) => (
    rate.active !== false
    && String(rate.fromCountry).toUpperCase() === from
    && String(rate.toCountry).toUpperCase() === to
    && String(rate.packageTier).toUpperCase() === tier
  )) || null;
}

/** Preview one seller parcel. Returns EUR cents or null if route missing. */
export function previewShipmentCents({ fromCountry, toCountry, cardCount }) {
  const tier = packageTierForCount(cardCount);
  const rate = findShippingRate({ fromCountry, toCountry, packageTier: tier });
  return rate ? Number(rate.priceEURCents) || 0 : null;
}

/** 1 PKN = 0.005 EUR → PKN from EUR cents. */
export function pknFromEurCents(cents) {
  const n = Number(cents) || 0;
  return Math.round((n / 100) / 0.005);
}
