import { useAuth } from './auth.jsx';
import {
  LIST_CURRENCIES,
  currencyForCountry,
  currencyFromLocale,
  formatLocalFromPkn,
  formatPkn,
} from './pkn.js';
import { buyerPrefersFiat, buyerPriceParts } from './seller-currency.js';
import { useSellerCurrency } from './use-seller-currency.js';

/**
 * Buyer-side display currency: the profile country's fiat (DK → DKK) once the
 * buyer's PKN balance cannot cover a price, PKN otherwise. Signed-out buyers
 * keep plain PKN. Settlement is always PKN — this only changes labels.
 */
export function useBuyerCurrency(pinned = '') {
  const { signedIn, availablePkn } = useAuth();
  const { settings } = useSellerCurrency();
  const country = String(settings?.shipFromCountry || '').toUpperCase();
  const pin = LIST_CURRENCIES.includes(String(pinned || '').toUpperCase())
    ? String(pinned).toUpperCase()
    : '';
  const currency = pin || currencyForCountry(country) || currencyFromLocale();
  const balancePkn = signedIn ? Math.max(0, Number(availablePkn) || 0) : null;
  const fiat = (pricePkn, sellerAcceptsPkn = true) => buyerPrefersFiat(balancePkn, pricePkn, sellerAcceptsPkn);
  const forceFiat = Boolean(pin && pin !== 'PKN');
  const format = (pricePkn, sellerAcceptsPkn = true) => (
    forceFiat || fiat(pricePkn, sellerAcceptsPkn)
      ? formatLocalFromPkn(pricePkn, currency)
      : formatPkn(pricePkn)
  );
  /**
   * { local, pkn } for <PriceStack>: pinned currencies keep the two-line
   * stack, unaffordable prices show local only, affordable prices PKN only.
   */
  const parts = (pricePkn, sellerAcceptsPkn = true) =>
    buyerPriceParts({ pricePkn, currency, balancePkn, sellerAcceptsPkn, pinned: pin });
  return { currency, balancePkn, fiat, format, parts, pinned: pin };
}
