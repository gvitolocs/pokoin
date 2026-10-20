/**
 * Reverse-holo / mirror scan of a printing (docs/REVERSE_SCANS.md).
 *
 * CardTrader sells reverse as a listing option of the one blueprint, so a
 * reverse scan is not its own card. The card page sends `card.reverseScan`
 * (pokoin-rust reverse_scan.rs, table market/src/data/reverse-scans.json) only
 * for printings with a verified scan on cdn.pokoin.com/reverse/. The desk then
 * shows the gold sparkles next to the expansion marks, which swap the hero.
 */
import { CDN_ORIGIN } from './image-urls.js';

const REVERSE = new RegExp(`^${CDN_ORIGIN.replace(/\./g, '\\.')}/reverse/\\d+_[A-Za-z0-9._-]+\\.jpg(?:\\?v=[A-Za-z0-9.-]+)?$`);

/** The verified reverse scan URL for this card, or '' when it has none. */
export function reverseScanUrl(card) {
  const url = String(card?.reverseScan || '');
  return REVERSE.test(url) ? url : '';
}

export const REVERSE_SCAN_LABEL = 'Reverse holo';
