/**
 * Sellers who opt out of PKN payments (Profile → Seller setup → "Get paid in
 * PKN") price and read their listings in their local currency: the card-page
 * list tile, the scan desk and MyPokoin default to it. Listings are still
 * stored in PKN (1 PKN = €0.005) — this only changes what the seller types
 * and sees. Buyers of those sellers pay by card (server/pokoin-api/_seller_pkn_policy.js).
 */
import { currencyForCountry, fiatFromPkn, formatFiatFromPkn, formatPkn, formatPknNumber, listingPriceToPkn } from './pkn.js';

/** 'PKN' for PKN-accepting sellers, else the ship-from country's currency. */
export function sellerListCurrency(settings) {
  if (!settings || settings.acceptsPkn !== false) return 'PKN';
  return currencyForCountry(settings.shipFromCountry) || 'EUR';
}

/** Stored PKN → the seller's price label (2642 PKN, €13.21, 99.08 DKK). */
export function formatSellerPrice(pkn, currency = 'PKN') {
  return currency === 'PKN' ? formatPkn(pkn) : formatFiatFromPkn(pkn, currency);
}

/** Stored PKN → what the price input shows in the seller's currency. */
export function priceInputFromPkn(pkn, currency = 'PKN') {
  if (pkn == null || pkn === '') return '';
  if (currency === 'PKN') return String(pkn);
  const amount = fiatFromPkn(pkn, currency);
  return amount == null ? '' : formatPknNumber(amount, { maximumFractionDigits: 2 });
}

/** What the seller typed, in their currency → PKN to store (null if invalid). */
export function pknFromPriceInput(raw, currency = 'PKN') {
  const pkn = listingPriceToPkn(raw, currency);
  if (pkn == null) return null;
  return currency === 'PKN' ? pkn : Math.round(pkn);
}
