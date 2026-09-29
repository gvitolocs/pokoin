import { useEffect, useState } from 'react';
import { fetchSellerSettings } from './api.js';
import { useAuth } from './auth.jsx';
import { sellerListCurrency } from './seller-currency.js';

// One settings request per page load, shared by every price field; Profile
// pushes a fresh value when the seller flips "Get paid in PKN".
let shared = null;
const listeners = new Set();

export function publishSellerSettings(settings) {
  shared = Promise.resolve(settings);
  for (const listener of listeners) listener(settings);
}

/** { currency, settings, failed }: the signed-in seller's listing currency. */
export function useSellerCurrency() {
  const { signedIn, getBearer } = useAuth();
  const [settings, setSettings] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    listeners.add(setSettings);
    return () => listeners.delete(setSettings);
  }, []);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    if (!shared) {
      shared = getBearer().then((token) => fetchSellerSettings(token)).catch((error) => {
        shared = null;
        throw error;
      });
    }
    shared
      .then((next) => { if (!cancelled) { setSettings(next); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  return { currency: sellerListCurrency(settings), settings, failed };
}
