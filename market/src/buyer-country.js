/**
 * The signed-in buyer's last known country (localStorage, per uid). Prices are
 * labelled in that country's currency from the first paint of a reload,
 * instead of holding every label until Firebase and the seller settings read
 * answer; the settings read still decides once it lands.
 */
export const BUYER_COUNTRY_KEY = 'pokoin.buyerCountry';

function store(override) {
  if (override) return override;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** `{ uid, country }` stored for this uid ('' = known, no country), or null. */
export function readBuyerCountry(uid, overrideStore) {
  const want = String(uid || '');
  if (!want) return null;
  try {
    const row = JSON.parse(store(overrideStore)?.getItem(BUYER_COUNTRY_KEY) || 'null');
    if (!row || row.uid !== want) return null;
    return { uid: want, country: String(row.country || '').trim().toUpperCase() };
  } catch {
    return null;
  }
}

export function writeBuyerCountry(uid, country, overrideStore) {
  const id = String(uid || '');
  if (!id) return;
  try {
    store(overrideStore)?.setItem(
      BUYER_COUNTRY_KEY,
      JSON.stringify({ uid: id, country: String(country || '').trim().toUpperCase() }),
    );
  } catch {
    /* quota / private mode: the next load waits for the settings read */
  }
}
