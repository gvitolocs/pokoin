import { useAuth } from './auth.jsx';
import {
  LIST_CURRENCIES,
  currencyForCountry,
  currencyFromLocale,
} from './pkn.js';
import { buyerPrefersFiat, buyerPriceLabel, buyerPriceParts } from './seller-currency.js';
import { useSellerCurrency } from './use-seller-currency.js';

/**
 * Buyer-side display currency: the profile country's fiat (DK → DKK) once the
 * buyer's PKN balance cannot cover a price, PKN otherwise. Signed-out buyers
 * keep plain PKN. Settlement is always PKN — this only changes labels.
 */
export function useBuyerCurrency(pinned = '') {
  const { signedIn, availablePkn } = useAuth();
  const { settings, pending: settingsPending } = useSellerCurrency();
  const country = String(settings?.shipFromCountry || '').toUpperCase();
  const pin = LIST_CURRENCIES.includes(String(pinned || '').toUpperCase())
    ? String(pinned).toUpperCase()
    : '';
  // Empty country used to fall through currencyForCountry('') → EUR, then
  // flip to DKK once the profile loaded. Hold the label until that arrives.
  const pending = !pin && Boolean(settingsPending);
  const currency = pin || (country ? currencyForCountry(country) : (pending ? '' : currencyFromLocale()));
  const balancePkn = signedIn ? Math.max(0, Number(availablePkn) || 0) : null;
  const fiat = (pricePkn, sellerAcceptsPkn = true) => !pending && buyerPrefersFiat(balancePkn, pricePkn, sellerAcceptsPkn);
  const format = (pricePkn, sellerAcceptsPkn = true) => (
    pending ? '' : buyerPriceLabel({ pricePkn, currency, balancePkn, sellerAcceptsPkn, pinned: pin })
  );
  /**
   * { local, pkn } for <PriceStack>: pinned currencies keep the two-line
   * stack, unaffordable prices show local only, affordable prices PKN only.
   */
  const parts = (pricePkn, sellerAcceptsPkn = true) => (
    pending
      ? { local: '', pkn: '', pending: true }
      : buyerPriceParts({ pricePkn, currency, balancePkn, sellerAcceptsPkn, pinned: pin })
  );
  return { currency, balancePkn, fiat, format, parts, pinned: pin, pending };
}
