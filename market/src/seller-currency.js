/**
 * Sellers who opt out of PKN payments (Profile → Seller setup → "Get paid in
 * PKN") price and read their listings in their local currency: the card-page
 * list tile, the scan desk and MyPokoin default to it. Listings are still
 * stored in PKN (1 PKN = €0.005) — this only changes what the seller types
 * and sees. Buyers of those sellers pay by card (server/pokoin-api/_seller_pkn_policy.js).
 */
import { currencyForCountry, currencyFromLocale, fiatFromPkn, formatFiatFromPkn, formatLocalFromPkn, formatPkn, formatPknNumber, listingPriceToPkn, localAndPknFromPkn } from './pkn.js';

/** 'PKN' for PKN-accepting sellers, else the ship-from country's currency. */
export function sellerListCurrency(settings) {
  if (!settings || settings.acceptsPkn !== false) return 'PKN';
  return currencyForCountry(settings.shipFromCountry) || 'EUR';
}

/** Stored PKN → the seller's price label: 2642 PKN, or €13.21 (2642 PKN). */
export function formatSellerPrice(pkn, currency = 'PKN') {
  return currency === 'PKN' ? formatPkn(pkn) : formatLocalFromPkn(pkn, currency);
}

/**
 * Buyer-facing listing price. Sellers who take card payments only show the
 * buyer's local currency first, PKN in brackets: €13.21 (2642 PKN).
 */
export function formatListingPrice(pkn, sellerAcceptsPkn = true, currency = currencyFromLocale()) {
  return sellerAcceptsPkn === false ? formatLocalFromPkn(pkn, currency) : formatPkn(pkn);
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

/**
 * Buyer display rule: a price renders in the buyer's local currency (DKK for
 * a Danish buyer) when the buyer cannot afford it with their PKN balance —
 * unaffordable prices show the local currency ONLY, no PKN line. Affordable
 * prices stay PKN-only: the currency they would actually pay with. Card-only
 * sellers always show local. Stored prices stay PKN either way.
 */
export function buyerPrefersFiat(balancePkn, pricePkn, sellerAcceptsPkn = true) {
  if (sellerAcceptsPkn === false) return true;
  if (balancePkn == null) return false; // signed out: plain PKN
  const balance = Number(balancePkn);
  if (!Number.isFinite(balance) || balance < 0) return false;
  return balance < (Number(pricePkn) || 0);
}

/**
 * { local, pkn } labels for a buyer price stack. A currency pinned through
 * the URL keeps the two-line local + PKN stack; an unaffordable signed-in
 * price (or a card-only seller) shows the local currency only; everything
 * else — affordable prices and signed-out buyers — PKN only.
 */
export function buyerPriceParts({ pricePkn, currency, balancePkn, sellerAcceptsPkn = true, pinned = '' }) {
  const pin = String(pinned || '').toUpperCase();
  if (pin && pin !== 'PKN') return localAndPknFromPkn(pricePkn, currency);
  if (buyerPrefersFiat(balancePkn, pricePkn, sellerAcceptsPkn)) {
    return { local: formatFiatFromPkn(pricePkn, currency) || '', pkn: '' };
  }
  return { local: '', pkn: formatPkn(pricePkn) || '' };
}
