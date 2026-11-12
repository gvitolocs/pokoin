/**
 * The desk's listing summary: the cheapest Pokoin listings of the card and the
 * buy offers for the language the chips picked. Framework-free; the two desk
 * cells (`solid/src/components/deal/CheapestListings.jsx` and `BuyOffers.jsx`)
 * render what is returned here, so nothing in this module touches the DOM.
 *
 * The lists live in their own grid cells now, so they size to their content:
 * there is no height to measure and no row fitting — `dealBookRows()` caps the
 * rows by viewport and that is the whole rule.
 */
import { CONDITIONS, pricedOffers } from './card-desk.js';
import { selectionBid } from './buy-orders.js';
import { isVaultOffer } from './vault.js';

/** Rows per list on the desktop desk; a stacked phone column shows fewer. */
export const DEAL_BOOK_MAX_ROWS = 3;
export const DEAL_BOOK_MAX_ROWS_PHONE = 2;
export const DEAL_BOOK_PHONE_MAX_WIDTH = 720;

/** Max rows per list for a viewport width. */
export function dealBookRows(width, { max = DEAL_BOOK_MAX_ROWS, phone = DEAL_BOOK_MAX_ROWS_PHONE } = {}) {
  return Number(width) > 0 && Number(width) <= DEAL_BOOK_PHONE_MAX_WIDTH ? phone : max;
}

/**
 * The `max` cheapest Pokoin listings of the card, cheapest first: every
 * condition and language, not only the facet the chips picked, and including
 * the listing the price band shows — this cell is the page's listing summary.
 * Vault stock is not a shop listing (it has its own desk row), so it is skipped.
 */
export function cheapestRows({ rows = [], max = DEAL_BOOK_MAX_ROWS } = {}) {
  const hits = pricedOffers(rows).filter((offer) => !isVaultOffer(offer));
  return max > 0 ? hits.slice(0, max) : hits;
}

/**
 * The `See all N listings` count: every non-Vault listing the card has, or 0
 * when this cell already shows them all.
 */
export function listingTotal({ rows = [] } = {}) {
  return pricedOffers(rows).filter((offer) => !isVaultOffer(offer)).length;
}

export function seeAllListings({ rows = [], shown = [] } = {}) {
  const total = listingTotal({ rows });
  return total > shown.length ? total : 0;
}

/**
 * The buy-order book for `language`: one row per condition (the same aggregation
 * the offer bar reads), best price first, capped at `max`.
 */
export function buyOfferRows(book, { language = '', max = DEAL_BOOK_MAX_ROWS } = {}) {
  const hits = CONDITIONS
    .filter((row) => row.value)
    .map((row) => selectionBid(book, { condition: row.value, language }))
    .filter(Boolean)
    .sort((a, b) => Number(b.best_price_pkn) - Number(a.best_price_pkn));
  return max > 0 ? hits.slice(0, max) : hits;
}

/** Every open offer of the card: the book's orders, in every grade and language. */
export function buyOfferTotal(book = []) {
  return (Array.isArray(book) ? book : [])
    .reduce((sum, row) => sum + (Number(row?.orders) || 0), 0);
}

/**
 * The `See all N offers` count: every offer the card has, or 0 when this cell
 * already shows them all. It is the card's total and not the picked facet's,
 * because the line leaves the desk for the BuySell board, which lists them all.
 */
export function seeAllOffers(book = [], shown = []) {
  const total = buyOfferTotal(book);
  return total > shown.length ? total : 0;
}

/** Sell now is reachable when the row names a best order the visitor did not post. */
export function buyOfferSellable(row, mine = []) {
  return Boolean(row?.best_order_id) && !mine.includes(row.best_order_id);
}

/**
 * The cell title's count: `3 of 100` while rows sit behind the cap, and the
 * plain `3` once the cell already shows everything it has.
 */
export function dealBookCount(shown = 0, total = 0) {
  return total > shown ? `${shown} of ${total}` : String(shown);
}
