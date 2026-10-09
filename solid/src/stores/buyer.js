import { createSignal } from 'solid-js';
import { fetchSellerSettings } from '@market/api.js';
import { currencyForCountry, currencyFromLocale } from '@market/pkn.js';
import { buyerPriceParts } from '@market/seller-currency.js';
import { getBearer, signedIn } from './auth.js';
import { authSession } from './session.js';

/**
 * Buyer display currency (market/src/use-buyer-currency.js + use-seller-currency.js):
 * profile country fiat once the PKN balance cannot cover a price, PKN
 * otherwise; signed-out buyers see PKN. One settings request per page load.
 * Labels only — settlement is always PKN.
 */
const [settings, setSettings] = createSignal(null);
const [failed, setFailed] = createSignal(false);
let requested = null;

export function ensureSellerSettings() {
  if (requested || !signedIn()) return requested;
  requested = getBearer()
    .then((token) => fetchSellerSettings(token))
    .then((next) => {
      setSettings(() => next);
      setFailed(false);
    })
    .catch(() => {
      requested = null;
      setFailed(true);
    });
  return requested;
}

/** Hold the label until the signed-in buyer's country is known (no EUR→DKK flip). */
export function buyerPending() {
  return signedIn() && settings() == null && !failed();
}

/** `{ local, pkn }` for <PriceStack>, same rules as useBuyerCurrency().parts. */
export function buyerParts(pricePkn, sellerAcceptsPkn = true) {
  if (buyerPending()) return { local: '', pkn: '', pending: true };
  const country = String(settings()?.shipFromCountry || '').toUpperCase();
  const currency = country ? currencyForCountry(country) : currencyFromLocale();
  const balancePkn = signedIn() ? Math.max(0, Number(authSession()?.availablePkn) || 0) : null;
  return buyerPriceParts({ pricePkn, currency, balancePkn, sellerAcceptsPkn, pinned: '' });
}
