/** Cloudflare WAF 403s `.svg` on pokoin.com; 63:88 Pokoin card with TCG corners. */
export const MISSING_CARD_SRC = '/home/missing-card.webp';

/** CardTrader `fallbacks/card_uploader/preview.png` and leftover JPEG copies. */
export function isCardTraderPlaceholderSize(width, height) {
  return Number(width) === 186 && Number(height) === 260;
}
