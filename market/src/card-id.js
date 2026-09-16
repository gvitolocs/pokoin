/**
 * Pure public-card-id arithmetic. React-free so Node-run scripts
 * (scripts/build-seo-sitemaps.mjs) can import it transitively;
 * card-stub.js re-exports these for the SPA.
 */

/** Storm Emeralda briefly used 999000000 + (ct_id × 2). Desk is leftover × 2. */
export const PROVISIONAL_PUBLIC_OFFSET = 999000000;

export function realPublicCardId(cardId) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) {
    return id;
  }
  const value = Number(id);
  if (value >= PROVISIONAL_PUBLIC_OFFSET) {
    return String(value - PROVISIONAL_PUBLIC_OFFSET);
  }
  return id;
}

/** Leftover dump id: public card id / 2. Desk paths stay public; image keys do not. */
export function leftoverCdnId(cardId) {
  const id = realPublicCardId(cardId);
  if (!/^\d+$/.test(id)) {
    return '';
  }
  try {
    const value = BigInt(id);
    if (value <= 0n) {
      return '';
    }
    if (value % 2n === 0n) {
      return String(value / 2n);
    }
    return id;
  } catch (_) {
    return '';
  }
}
