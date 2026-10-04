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
  // findRate falls back to whatever the lane has, so a lane with only an
  // untracked letter (e.g. IT → JP) answers the tracked ask with that letter:
  // label each option by the rate it really is, once.
  const options = [];
  for (const want of [true, false]) {
    const row = previewShipment({ fromCountry, toCountry, cardCount, tracked: want });
    if (!row) continue;
    const id = row.tracked ? 'tracked' : 'untracked';
    if (options.some((option) => option.id === id || option.rateId === row.rateId)) continue;
    options.push({ id, label: row.tracked ? 'Tracked' : 'Untracked', ...row });
  }
  // Always offer Pokoin Flex in the chooser, disabled until partner stores launch.
  options.push(pokoinFlexOption());
  return options;
}

/** Tiers that still travel as a letter (up to 20 cards). */
const LETTER_TIERS = new Set(['SMALL', 'MEDIUM']);

/**
 * Pre-selected service before the buyer picks one: a few cards go as the
 * untracked letter (IT→DK 1–4 cards: Posta Ordinaria €1.30 vs tracked parcel);
 * bigger parcels default to tracked. The buyer can always switch.
 */
export function defaultShippingService(options = []) {
  const selectable = (options || []).filter((row) => !row.unavailable);
  const letter = selectable.find((row) => row.id === 'untracked' && LETTER_TIERS.has(row.packageTier));
  return (letter || selectable[0] || options[0] || {}).id || 'tracked';
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
