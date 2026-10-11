// Fixed Stripe PKN packages on /buy. Credits site balance, not chain PKN.

import { PKN_USDT_PRICE } from './pkn.js';

export const PKN_PACKAGE_RATE = PKN_USDT_PRICE;

export const PKN_PACKAGES = [
  { label: 'Starter', fiatCents: 500, lookupKey: 'pkn_starter_1000_pkn_500_eur' },
  { label: 'Collector', fiatCents: 2500, lookupKey: 'pkn_collector_5000_pkn_2500_eur' },
  { label: 'Validator', fiatCents: 10000, lookupKey: 'pkn_validator_20000_pkn_10000_eur' },
];

/** Whole PKN a package credits. */
export function pknPackageAmount(item) {
  return Math.round(item.fiatCents / 100 / PKN_PACKAGE_RATE);
}

/** /buy?session_id=… return path, so sign-in comes back to the confirmation. */
export function buyReturnPath(sessionId) {
  return sessionId ? `/buy?session_id=${encodeURIComponent(sessionId)}` : '/buy';
}
