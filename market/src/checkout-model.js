// /checkout rules without a UI framework: order payloads, the address draft,
// seller parcels and the shipping preview. Checkout.jsx (React) and the Solid
// checkout page both use these; fees live in checkout-fees.js.

import { countryFromLocale } from './pkn.js';
import { SHIP_TO_COUNTRIES } from './ship-countries.js';
import {
  isUntrackedService,
  previewShipmentCents,
  shippingServiceOptions,
} from './shipping-quote.js';

/** "This order contains a gift" in the cart pre-fills the note to the sellers. */
export const GIFT_NOTE = 'This order is a gift: please leave prices and receipts out of the parcel.';

/** Fallback shipping when no route preview exists (PKN). */
export const CHECKOUT_SHIPPING_PKN = 2000;

/** One line of a site-PKN order (POST /api/marketplace-orders). */
export function orderLineSnapshot(row, fulfillmentMode, notes) {
  const qty = Number(row.qty) || 1;
  const unit = Number(row.pricePkn) || 0;
  return {
    listingId: row.listingId,
    sellerUid: row.sellerUid,
    sellerName: row.sellerName,
    quantity: qty,
    unitPricePkn: unit,
    totalPricePkn: unit * qty,
    condition: row.condition,
    language: row.language,
    reserveAvailable: Boolean(row.reserveAvailable),
    nftAvailable: Boolean(row.nftAvailable),
    fulfillmentMode,
    card: row.card || { id: row.cardId, name: row.name },
    ...(notes ? { buyerNotes: notes } : {}),
  };
}

/** Cart rows as the quote / Stripe session payload (the server re-prices them). */
export function checkoutCartPayload(items) {
  return items.map((row) => ({
    listingId: row.listingId,
    sellerUid: row.sellerUid,
    sellerName: row.sellerName,
    qty: Number(row.qty) || 1,
    quantity: Number(row.qty) || 1,
    pricePkn: Number(row.pricePkn) || 0,
    unitPricePkn: Number(row.pricePkn) || 0,
    cardId: row.cardId,
    name: row.name,
    card: row.card || { id: row.cardId, name: row.name },
  }));
}

export function emptyAddressDraft(preferred = '') {
  const localeCountry = SHIP_TO_COUNTRIES.some((row) => row.code === preferred) ? preferred : countryFromLocale();
  const known = SHIP_TO_COUNTRIES.some((row) => row.code === localeCountry);
  return {
    fullName: '',
    addressLine1: '',
    addressLine2: '',
    postalCode: '',
    city: '',
    countryCode: known ? localeCountry : 'DK',
    phoneNumber: '',
  };
}

/** The address form's text fields, in order. */
export const ADDRESS_FIELDS = [
  ['fullName', 'Full name'],
  ['addressLine1', 'Address line 1'],
  ['addressLine2', 'Address line 2 (optional)'],
  ['postalCode', 'Postal code'],
  ['city', 'City'],
  ['phoneNumber', 'Phone (optional)'],
];

export function addressFieldRequired(key) {
  return key !== 'addressLine2' && key !== 'phoneNumber';
}

export function selectedAddressCountry(addresses, addressId) {
  const row = (addresses || []).find((item) => item.id === addressId);
  return String(row?.countryCode || '').trim().toUpperCase();
}

/** One parcel per seller: card count and ship-from country (profile origin first). */
export function checkoutSellerParcels(items, origins = {}) {
  const bySeller = new Map();
  for (const row of items) {
    const sid = String(row.sellerUid || '');
    const fromProfile = String(origins[sid] || '').toUpperCase();
    const list = bySeller.get(sid) || {
      sellerId: sid,
      sellerName: row.sellerName || '',
      count: 0,
      from: fromProfile || String(row.sellerCountry || '').toUpperCase(),
    };
    list.count += Number(row.qty) || 0;
    list.from = list.from || fromProfile || String(row.sellerCountry || '').toUpperCase();
    list.sellerName = list.sellerName || row.sellerName || '';
    bySeller.set(sid, list);
  }
  return [...bySeller.values()];
}

/** Shipping services for the first parcel with a known origin (untracked only when allowed). */
export function checkoutShipOptions({ nft, sellerParcels, buyerCountry, allowUntracked }) {
  if (nft || !sellerParcels.length) return [];
  for (const group of sellerParcels) {
    if (!group.from) continue;
    const options = shippingServiceOptions({
      fromCountry: group.from,
      toCountry: buyerCountry,
      cardCount: group.count,
    }).filter((row) => allowUntracked || !isUntrackedService(row));
    if (options.length) return options;
  }
  return [];
}

/** Euro-cents shipping: the server quote, else the rate-table preview; null when a parcel has no rate. */
export function checkoutShippingPreviewCents({ nft, itemCount, quote, sellerParcels, buyerCountry, tracked }) {
  if (nft || !itemCount) return 0;
  if (quote && Number.isFinite(Number(quote.shippingTotalCents))) {
    return Number(quote.shippingTotalCents);
  }
  let total = 0;
  for (const group of sellerParcels) {
    if (!group.from) return null;
    const cents = previewShipmentCents({
      fromCountry: group.from,
      toCountry: buyerCountry,
      cardCount: group.count,
      tracked,
    });
    if (cents == null) return null;
    total += cents;
  }
  return total;
}

/** Card value from sellers who take PKN — what the balance voucher may cover. */
export function pknEligibleSubtotal(items, pknRefused) {
  return items.reduce((sum, row) => (
    pknRefused.some((seller) => seller.uid === row.sellerUid)
      ? sum
      : sum + Math.max(0, Number(row.pricePkn) || 0) * Math.max(0, Number(row.qty) || 0)
  ), 0);
}

/** Sorted seller uids, the key for the "who refuses PKN" lookup. */
export function checkoutSellerKey(items) {
  return [...new Set(items.map((row) => String(row.sellerUid || '')).filter(Boolean))].sort().join(',');
}

export const MISSING_LISTING_ERROR = 'A cart row is missing listingId. Add the offer from Shop again.';

/** Stripe session errors: a price change asks for a refresh, nothing was charged. */
export function stripeSessionError(err) {
  const code = err?.body?.code;
  return code === 'price_mismatch' || err?.status === 409
    ? `${err.message} Refresh the card in your cart and try again — nothing was charged.`
    : (err.message || 'Could not open Stripe.');
}
