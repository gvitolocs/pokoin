import { useAuth } from './auth.jsx';
import { currencyForCountry, currencyFromLocale, formatLocalFromPkn, formatPkn, localAndPknFromPkn } from './pkn.js';
import { buyerPrefersFiat } from './seller-currency.js';
import { useSellerCurrency } from './use-seller-currency.js';

/**
 * Buyer-side display currency: the profile country's fiat (DK → DKK) once the
 * buyer's PKN balance cannot cover a price, PKN otherwise. Signed-out buyers
 * keep plain PKN. Settlement is always PKN — this only changes labels.
 */
export function useBuyerCurrency() {
  const { signedIn, availablePkn } = useAuth();
  const { settings } = useSellerCurrency();
  const country = String(settings?.shipFromCountry || '').toUpperCase();
  const currency = currencyForCountry(country) || currencyFromLocale();
  const balancePkn = signedIn ? Math.max(0, Number(availablePkn) || 0) : null;
  const fiat = (pricePkn, sellerAcceptsPkn = true) => buyerPrefersFiat(balancePkn, pricePkn, sellerAcceptsPkn);
  const format = (pricePkn, sellerAcceptsPkn = true) => (
    fiat(pricePkn, sellerAcceptsPkn)
      ? formatLocalFromPkn(pricePkn, currency)
      : formatPkn(pricePkn)
  );
  /** { local, pkn } for <PriceStack>: local is '' while the price stays PKN-only. */
  const parts = (pricePkn, sellerAcceptsPkn = true) => (
    fiat(pricePkn, sellerAcceptsPkn)
      ? localAndPknFromPkn(pricePkn, currency)
      : { local: '', pkn: formatPkn(pricePkn) || '' }
  );
  return { currency, balancePkn, fiat, format, parts };
}
