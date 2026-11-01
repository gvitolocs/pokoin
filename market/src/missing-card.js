/** Cloudflare WAF 403s `.svg` on pokoin.com; 63:88 Pokoin card with TCG corners. */
export const MISSING_CARD_SRC = '/home/missing-card.webp';

/** A scan whose every sibling failed is fetched once more after this wait. */
export const MISSING_CARD_RETRY_MS = 1500;

/**
 * `url` with `r=<attempt>`, so a retry round is a new request rather than the
 * browser's cached failure. Attempt 0 (or no URL) leaves it unchanged.
 */
export function retryImageUrl(url, attempt) {
  const value = String(url || '');
  if (!attempt || !value) return value;
  const hashAt = value.indexOf('#');
  const hash = hashAt >= 0 ? value.slice(hashAt) : '';
  const head = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = head.indexOf('?');
  const path = queryAt >= 0 ? head.slice(0, queryAt) : head;
  const params = queryAt >= 0 ? head.slice(queryAt + 1).split('&').filter((p) => p && !/^r(=|$)/.test(p)) : [];
  params.push(`r=${attempt}`);
  return `${path}?${params.join('&')}${hash}`;
}

/** CardTrader `fallbacks/card_uploader/preview.png` and leftover JPEG copies. */
export function isCardTraderPlaceholderSize(width, height) {
  return Number(width) === 186 && Number(height) === 260;
}
