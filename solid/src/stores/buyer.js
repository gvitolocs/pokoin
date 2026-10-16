import { createSignal } from 'solid-js';
import { fetchSellerSettings } from '@market/api.js';
import { readBuyerCountry, writeBuyerCountry } from '@market/buyer-country.js';
import { currencyForCountry, currencyFromLocale, LIST_CURRENCIES } from '@market/pkn.js';
import { buyerPrefersFiat, buyerPriceLabel, buyerPriceParts, sellerListCurrency } from '@market/seller-currency.js';
import { getBearer, signedIn } from './auth.js';
import { authSession } from './session.js';

/**
 * Buyer display currency:
 * profile country fiat once the PKN balance cannot cover a price, PKN
 * otherwise; signed-out buyers see PKN. One settings request per page load.
 * Labels only — settlement is always PKN.
 */
const [settings, setSettings] = createSignal(null);
const [failed, setFailed] = createSignal(false);
let requested = null;

// The country the last settings read gave this uid (market/src/buyer-country.js):
// on a reload, labels paint in its currency while the read is on its way.
const [known, setKnown] = createSignal(readBuyerCountry(authSession()?.uid));

function knownCountry() {
  const row = known();
  return row && row.uid === String(authSession()?.uid || '') ? row : null;
}

function rememberCountry(next) {
  const uid = authSession()?.uid;
  if (!uid || !next) return;
  writeBuyerCountry(uid, next.shipFromCountry);
  setKnown(() => readBuyerCountry(uid));
}

export function ensureSellerSettings() {
  if (requested || !signedIn()) return requested;
  requested = getBearer()
    .then((token) => fetchSellerSettings(token))
    .then((next) => {
      setSettings(() => next);
      setFailed(false);
      rememberCountry(next);
    })
    .catch(() => {
      requested = null;
      setFailed(true);
    });
  return requested;
}

/** Hold the label until the signed-in buyer's country is known (no EUR→DKK flip). */
export function buyerPending() {
  return signedIn() && settings() == null && !failed() && !knownCountry();
}

/** The signed-in seller's settings (ship-from country, PKN payouts); null until fetched. */
export const sellerSettings = settings;

/** useSellerCurrency().failed: the settings read failed (callers fall back to defaults). */
export const sellerSettingsFailed = failed;

/**
 * use-seller-currency.js publishSellerSettings: Profile pushes a fresh value
 * when the seller flips "Get paid in PKN" or the ship-from country.
 */
export function publishSellerSettings(next) {
  requested = Promise.resolve();
  setSettings(() => next);
  setFailed(false);
  rememberCountry(next);
}

/** useSellerCurrency().currency: PKN, or local fiat for sellers who turned PKN payments off. */
export const sellerCurrency = () => sellerListCurrency(settings());

/** A `?currency=` pin (LIST_CURRENCIES) or '' — same rule as useBuyerCurrency(pinned). */
function pinOf(pinned) {
  const code = String(pinned || '').toUpperCase();
  return LIST_CURRENCIES.includes(code) ? code : '';
}

function buyerContext(pinned) {
  const pin = pinOf(pinned);
  const pending = !pin && buyerPending();
  const country = String((settings() ? settings().shipFromCountry : knownCountry()?.country) || '').toUpperCase();
  const currency = pin || (country ? currencyForCountry(country) : currencyFromLocale());
  const balancePkn = signedIn() ? Math.max(0, Number(authSession()?.availablePkn) || 0) : null;
  return { pin, pending, currency, balancePkn };
}

/** `{ local, pkn }` for <PriceStack>, same rules as useBuyerCurrency(pinned).parts. */
export function buyerParts(pricePkn, sellerAcceptsPkn = true, pinned = '') {
  const { pin, pending, currency, balancePkn } = buyerContext(pinned);
  if (pending) return { local: '', pkn: '', pending: true };
  return buyerPriceParts({ pricePkn, currency, balancePkn, sellerAcceptsPkn, pinned: pin });
}

/** One-line label, same as useBuyerCurrency(pinned).format ('' while pending). */
export function buyerFormat(pricePkn, sellerAcceptsPkn = true, pinned = '') {
  const { pin, pending, currency, balancePkn } = buyerContext(pinned);
  if (pending) return '';
  return buyerPriceLabel({ pricePkn, currency, balancePkn, sellerAcceptsPkn, pinned: pin });
}

/** useBuyerCurrency().currency: '' while the signed-in buyer's country is still loading. */
export function buyerCurrency(pinned = '') {
  const { pending, currency } = buyerContext(pinned);
  return pending ? '' : currency;
}

/** useBuyerCurrency().fiat: true when this price shows in local fiat (balance cannot cover it). */
export function buyerFiat(pricePkn, sellerAcceptsPkn = true, pinned = '') {
  const { pending, balancePkn } = buyerContext(pinned);
  return !pending && buyerPrefersFiat(balancePkn, pricePkn, sellerAcceptsPkn);
}

/** useBuyerCurrency().pinned: the `?currency=` pin, or ''. */
export const buyerPinned = pinOf;
