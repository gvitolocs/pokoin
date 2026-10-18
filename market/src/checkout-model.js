// /checkout rules without a UI framework: order payloads, the address draft,
// seller parcels and the shipping preview. Checkout.jsx (React) and the Solid
// checkout page both use these; fees live in checkout-fees.js.

import { countryFromLocale } from './pkn.js';
import { SHIP_TO_COUNTRIES } from './ship-countries.js';
import { isBookableShippingService } from './shipping-choice.js';
import {
  cheapestServiceId,
  isUntrackedService,
  parcelServiceLabel,
  pokoinFlexOption,
  previewShipment,
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

/**
 * POST body for /api/marketplace-checkout-quote and the Stripe session: the
 * server re-prices every line, each parcel's service and the balance
 * discount. The buyer only opts in to the discount; no amount is sent.
 */
export function checkoutRequestBody({
  items,
  addressId = '',
  toCountry = '',
  services = {},
  insurance = false,
  useBalance = false,
}) {
  const tracked = Object.values(services || {}).every((id) => id !== 'untracked');
  return {
    items: checkoutCartPayload(items),
    ...(addressId ? { shippingAddressId: addressId } : { toCountry }),
    shippingService: tracked ? 'tracked' : 'untracked',
    shippingServices: { ...(services || {}) },
    tracked,
    insurance: Boolean(insurance),
    usePknDiscount: Boolean(useBalance),
  };
}

/** What Stripe charges: the server's `chargeCents`, else the total less its discount. */
export function checkoutChargeCents(quote) {
  if (!quote) return null;
  if (quote.chargeCents != null && Number.isFinite(Number(quote.chargeCents))) {
    return Number(quote.chargeCents);
  }
  const total = Number(quote.grandTotalCents);
  if (quote.grandTotalCents == null || !Number.isFinite(total)) return null;
  return total - (Number(quote.pknDiscount?.eurCents) || 0);
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

/**
 * Tracked / untracked for the whole order, priced as checkout charges it: one
 * parcel per seller, each on its own lane (seller country → buyer), summed.
 * `parcels` lists each seller's share so the page can show them separately.
 */
export function checkoutShipOptions({ nft, sellerParcels, buyerCountry, allowUntracked }) {
  if (nft || !sellerParcels.length) return [];
  const lanes = sellerParcels.filter((group) => group.from);
  if (!lanes.length) return [];
  if (lanes.length === 1) {
    const [group] = lanes;
    return shippingServiceOptions({
      fromCountry: group.from,
      toCountry: buyerCountry,
      cardCount: group.count,
    }).filter((row) => allowUntracked || !isUntrackedService(row));
  }
  const options = [];
  for (const want of [true, false]) {
    const parcels = lanes.map((group) => ({
      sellerId: group.sellerId,
      sellerName: group.sellerName,
      from: group.from,
      row: previewShipment({ fromCountry: group.from, toCountry: buyerCountry, cardCount: group.count, tracked: want }),
    }));
    // A seller lane with no rate at all: checkout cannot book this order.
    if (parcels.some((parcel) => !parcel.row)) continue;
    // Lanes without the asked kind answer with what they have (as the server does).
    const id = parcels.some((parcel) => parcel.row.tracked) ? 'tracked' : 'untracked';
    if (options.some((option) => option.id === id)) continue;
    const option = {
      id,
      label: id === 'tracked' ? 'Tracked' : 'Untracked',
      tracked: id === 'tracked',
      amountCents: parcels.reduce((sum, parcel) => sum + parcel.row.amountCents, 0),
      serviceName: `${parcels.length} parcels`,
      parcels: parcels.map((parcel) => ({
        sellerId: parcel.sellerId,
        sellerName: parcel.sellerName,
        fromCountry: parcel.row.fromCountry,
        toCountry: parcel.row.toCountry,
        serviceName: parcel.row.serviceName,
        tracked: parcel.row.tracked,
        amountCents: parcel.row.amountCents,
      })),
    };
    if (allowUntracked || !isUntrackedService(option)) options.push(option);
  }
  if (!options.length) return [];
  options.push(pokoinFlexOption());
  return options;
}

/** The letter services one seller parcel can book on its lane, cheapest first. */
export function checkoutParcelOptions({ from, to, count, allowUntracked = true }) {
  if (!from || !to || !(Number(count) > 0)) return [];
  return shippingServiceOptions({ fromCountry: from, toCountry: to, cardCount: count })
    .filter((row) => !row.unavailable && isBookableShippingService(row.id))
    .filter((row) => allowUntracked || !isUntrackedService(row))
    .map((row) => ({ ...row, label: parcelServiceLabel(row) }))
    .sort((a, b) => a.amountCents - b.amountCents);
}

/**
 * One parcel per seller, each on its own service, by the cart's rule: the
 * buyer's pick for that parcel, else the order-wide service when that lane
 * offers it (the picked one, else the cheapest one every parcel offers), else
 * the parcel's cheapest. `services` ({ sellerUid: serviceId }) is what the
 * quote and the Stripe session book.
 */
export function checkoutParcelShipping({ nft, sellerParcels, buyerCountry, allowUntracked, picks = {}, service = '' }) {
  if (nft) return { parcels: [], services: {}, cents: 0, missing: 0 };
  const to = String(buyerCountry || '').toUpperCase();
  const lanes = (sellerParcels || []).map((group) => ({
    group,
    options: checkoutParcelOptions({ from: group.from, to, count: group.count, allowUntracked }),
  }));
  const byId = new Map();
  for (const { options } of lanes) {
    for (const option of options) {
      const row = byId.get(option.id) || { id: option.id, tracked: option.tracked, amountCents: 0, parcels: 0 };
      row.amountCents += option.amountCents;
      row.parcels += 1;
      byId.set(option.id, row);
    }
  }
  const orderRows = [...byId.values()].map((row) => ({ ...row, complete: row.parcels === lanes.length }));
  const active = orderRows.some((row) => row.id === service)
    ? service
    : cheapestServiceId(orderRows, { allowUntracked });
  const parcels = [];
  const services = {};
  let cents = 0;
  let missing = 0;
  for (const { group, options } of lanes) {
    const wanted = picks?.[group.sellerId] || '';
    const picked = (wanted && options.find((row) => row.id === wanted))
      || (active && options.find((row) => row.id === active))
      || options[0]
      || null;
    parcels.push({
      sellerId: group.sellerId,
      sellerName: group.sellerName,
      from: group.from,
      to,
      count: group.count,
      options,
      serviceId: picked?.id || '',
      amountCents: picked ? picked.amountCents : null,
      tracked: picked ? picked.tracked !== false : true,
      serviceName: picked?.serviceName || '',
      carrier: picked?.carrier || '',
      fallback: Boolean(wanted && picked && picked.id !== wanted),
    });
    if (picked) {
      services[group.sellerId] = picked.id;
      cents += picked.amountCents;
    } else {
      missing += 1;
    }
  }
  return { parcels, services, cents, missing };
}

/** Euro-cents shipping: the server quote, else the rate-table preview; null when a parcel has no rate. */
export function checkoutShippingPreviewCents({ nft, itemCount, quote, sellerParcels, buyerCountry, tracked, services = {} }) {
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
      tracked: services[group.sellerId] ? services[group.sellerId] !== 'untracked' : tracked,
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
