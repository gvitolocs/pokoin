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

export function findShippingRate({
  fromCountry,
  toCountry,
  packageTier,
  tracked = true,
  catalog = ratesCatalog,
} = {}) {
  const from = String(fromCountry || '').trim().toUpperCase();
  const to = String(toCountry || '').trim().toUpperCase();
  const tier = String(packageTier || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(from) || !/^[A-Z]{2}$/.test(to) || !tier) return null;
  const wantTracked = tracked !== false;
  const matches = (catalog.rates || []).filter((rate) => (
    rate.active !== false
    && String(rate.fromCountry).toUpperCase() === from
    && String(rate.toCountry).toUpperCase() === to
    && String(rate.packageTier).toUpperCase() === tier
  ));
  return matches.find((rate) => (rate.tracked !== false) === wantTracked)
    || matches.find((rate) => wantTracked)
    || matches[0]
    || null;
}

/** Preview one seller parcel. Returns rate row fields or null. */
export function previewShipment({ fromCountry, toCountry, cardCount, tracked = true }) {
  const tier = packageTierForCount(cardCount);
  const rate = findShippingRate({ fromCountry, toCountry, packageTier: tier, tracked });
  if (!rate) return null;
  return {
    rateId: rate.id,
    fromCountry: String(rate.fromCountry).toUpperCase(),
    toCountry: String(rate.toCountry).toUpperCase(),
    packageTier: tier,
    tracked: rate.tracked !== false,
    carrier: rate.carrier || '',
    serviceName: rate.serviceName || 'Standard',
    amountCents: Number(rate.priceEURCents) || 0,
  };
}

/** Preview EUR cents for one parcel, or null if route missing. */
export function previewShipmentCents({ fromCountry, toCountry, cardCount, tracked = true }) {
  const row = previewShipment({ fromCountry, toCountry, cardCount, tracked });
  return row ? row.amountCents : null;
}

/** List tracked + untracked options for a route (when both exist). */
export function shippingServiceOptions({ fromCountry, toCountry, cardCount }) {
  const tracked = previewShipment({ fromCountry, toCountry, cardCount, tracked: true });
  const untracked = previewShipment({ fromCountry, toCountry, cardCount, tracked: false });
  const options = [];
  if (tracked) {
    options.push({ id: 'tracked', label: 'Tracked', ...tracked });
  }
  if (untracked && (!tracked || untracked.rateId !== tracked.rateId)) {
    options.push({ id: 'untracked', label: 'Untracked', ...untracked });
  }
  // Always offer Pokoin Flex in the chooser, disabled until partner stores launch.
  options.push(pokoinFlexOption());
  return options;
}

/** Checkout-only placeholder: partner-store pick-up / drop-off, not selectable yet. */
export function pokoinFlexOption() {
  return {
    id: 'pokoin_flex',
    label: 'Pokoin Flex',
    brand: 'pokoin-flex',
    unavailable: true,
    unavailableReason: 'Coming soon — Flex boxes (sturdy + padded), drop at a partner, fill a ~20 kg bag.',
    href: '/flex',
    amountCents: null,
    serviceName: 'Partner store',
    carrier: 'Pokoin Flex',
  };
}

/** 1 PKN = 0.005 EUR → PKN from EUR cents. */
export function pknFromEurCents(cents) {
  const n = Number(cents) || 0;
  return Math.round((n / 100) / 0.005);
}
