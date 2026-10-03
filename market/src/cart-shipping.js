// Cart shipping preview from the same rates table checkout quotes
// (shipping-rates.json, built by scripts/sync-shipping-rates.py): one parcel
// per seller, the service the buyer picked (tracked / untracked letter), and
// how many more cards ride in that parcel at the same price. Only the cart
// page imports this, so the rates table stays out of the main bundle.

import ratesCatalog from './shipping-rates.json' with { type: 'json' };
import { defaultShippingService, previewShipment, shippingServiceOptions } from './shipping-quote.js';

const TIERS = [...(ratesCatalog.tiers || [])].sort((a, b) => a.maxCards - b.maxCards);

/** Cards past this many are not worth a "room for N more" line. */
export const PARCEL_ROOM_MAX = 200;

function iso(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'EU' ? code : '';
}

/** Every bookable service for one parcel, cheapest first ({ id, label, amountCents, … }). */
export function parcelServices({ from, to, cards } = {}) {
  const n = Math.max(0, Math.trunc(Number(cards) || 0));
  const fromCode = iso(from);
  const toCode = iso(to);
  if (n < 1 || !fromCode || !toCode) return [];
  return shippingServiceOptions({ fromCountry: fromCode, toCountry: toCode, cardCount: n })
    .filter((row) => !row.unavailable)
    .sort((a, b) => a.amountCents - b.amountCents);
}

/**
 * One seller parcel: the buyer's service when that lane offers it, else
 * checkout's default (a few cards go as the untracked letter), plus the room
 * left at that price. `fallback` says the picked service was not available.
 */
export function parcelEstimate({ from, to, cards, service = '' } = {}) {
  const n = Math.max(0, Math.trunc(Number(cards) || 0));
  const options = parcelServices({ from, to, cards: n });
  if (!options.length) return null;
  const wanted = service ? options.find((row) => row.id === service) : null;
  const picked = wanted || options.find((row) => row.id === defaultShippingService(options)) || options[0];
  const tracked = picked.tracked !== false;
  let room = 0;
  for (const tier of TIERS) {
    const max = Number(tier.maxCards) || 0;
    if (max < n) continue;
    const at = previewShipment({ fromCountry: iso(from), toCountry: iso(to), cardCount: max, tracked });
    if (!at || at.amountCents !== picked.amountCents || at.tracked !== tracked) break;
    room = max - n;
  }
  return {
    serviceId: picked.id,
    amountCents: Number(picked.amountCents) || 0,
    tracked,
    serviceName: picked.serviceName || '',
    carrier: picked.carrier || '',
    packageTier: picked.packageTier || '',
    room: Math.min(room, PARCEL_ROOM_MAX),
    fallback: Boolean(service && !wanted),
  };
}

/** Shipping preview for the ticked rows with the buyer's service: one parcel per seller. */
export function shippingEstimate(groups = [], to = '', service = '') {
  const parcels = [];
  let cents = 0;
  let missing = 0;
  for (const group of groups || []) {
    if (!group.selectedCount) continue;
    const estimate = parcelEstimate({ from: group.sellerCountry, to, cards: group.selectedCount, service });
    parcels.push({ key: group.key, estimate });
    if (estimate) cents += estimate.amountCents;
    else missing += 1;
  }
  return { parcels, cents, missing, count: parcels.length };
}

/**
 * The services the buyer can pick for the whole order, with the order's
 * shipping total under each. `complete` is false when some parcel cannot use
 * that service (checkout then falls back to what that lane offers).
 */
export function orderServices(groups = [], to = '') {
  const byId = new Map();
  const ticked = (groups || []).filter((group) => group.selectedCount);
  for (const group of ticked) {
    for (const option of parcelServices({ from: group.sellerCountry, to, cards: group.selectedCount })) {
      const row = byId.get(option.id) || {
        id: option.id,
        label: option.label || option.serviceName || option.id,
        carrier: option.carrier || '',
        tracked: option.tracked !== false,
        cents: 0,
        parcels: 0,
      };
      row.cents += Number(option.amountCents) || 0;
      row.parcels += 1;
      byId.set(option.id, row);
    }
  }
  return [...byId.values()]
    .map((row) => ({ ...row, complete: row.parcels === ticked.length }))
    .sort((a, b) => Number(b.complete) - Number(a.complete) || a.cents - b.cents);
}

/**
 * Pokoin's "Add €30.21 to qualify for FREE Delivery": the ticked parcel with
 * the dearest shipping that still has room for more cards at the same price.
 */
export function parcelNudge(groups = [], to = '', service = '') {
  let best = null;
  for (const group of groups || []) {
    if (!group.selectedCount) continue;
    const estimate = parcelEstimate({ from: group.sellerCountry, to, cards: group.selectedCount, service });
    if (!estimate || estimate.room < 1) continue;
    if (!best || estimate.amountCents > best.estimate.amountCents) {
      best = { group, estimate };
    }
  }
  return best;
}
