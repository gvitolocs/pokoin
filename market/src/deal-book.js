/**
 * The card desk's Best Deal book: the other sellers of the facet the chips
 * selected, the buy offers for it, and how many whole rows fit the spare height
 * of the column. Framework-free; solid/src/components/deal/DealBook.jsx renders
 * what dealBookPlan() returns, so nothing here touches the DOM.
 *
 * The book never grows the panel: it only fills what the stretched column leaves
 * free above the offer bar, and a list with no room renders no rows at all.
 */
import { CONDITIONS, moodCondition, offerLanguage, pricedOffers } from './card-desk.js';
import { selectionBid } from './buy-orders.js';
import { listingSelectId } from './shop-marquee.js';
import { isVaultOffer } from './vault.js';

/** Rows per list in the wide desk; a stacked phone column shows fewer. */
export const DEAL_BOOK_MAX_ROWS = 3;
export const DEAL_BOOK_MAX_ROWS_PHONE = 2;
/** Only the three-column desk (styles.css) stretches the panel beside the centre column. */
export const DEAL_BOOK_WIDE_MIN_WIDTH = 1101;
export const DEAL_BOOK_PHONE_MAX_WIDTH = 720;

/**
 * Row heights in px. styles.css sizes the book from the same numbers through
 * --deal-book-* custom properties, and DealBook reads those properties back, so
 * the fit test and the layout cannot drift apart.
 */
export const DEAL_BOOK_METRICS = { row: 50, gap: 6, head: 20, more: 24, block: 14 };

/** Max rows per list for a viewport width. */
export function dealBookRows(width, { max = DEAL_BOOK_MAX_ROWS, phone = DEAL_BOOK_MAX_ROWS_PHONE } = {}) {
  return Number(width) > 0 && Number(width) <= DEAL_BOOK_PHONE_MAX_WIDTH ? phone : max;
}

/** True where the panel is stretched beside the centre column and has spare height to measure. */
export function dealBookMeasured(width) {
  return Number(width) >= DEAL_BOOK_WIDE_MIN_WIDTH;
}

/**
 * The next-cheapest Pokoin listings of the chips' condition + language, cheapest
 * first: never the listing Best Deal already shows, never the Vault (that stock
 * has its own panel below), never more than `max`.
 */
export function otherSellerRows({
  rows = [],
  deal = null,
  language = '',
  condition = '',
  card = null,
  max = DEAL_BOOK_MAX_ROWS,
} = {}) {
  const skip = deal ? listingSelectId(deal) : '';
  const hits = pricedOffers(rows).filter((offer) => {
    if (isVaultOffer(offer)) return false;
    if (skip && listingSelectId(offer) === skip) return false;
    if (language && offerLanguage(offer, card) !== language) return false;
    if (condition && moodCondition(offer) !== condition) return false;
    return true;
  });
  return max > 0 ? hits.slice(0, max) : hits;
}

/**
 * The "See all N listings" count: every non-Vault listing the card has, or 0 when
 * Best Deal and these rows already cover them all.
 */
export function seeAllListings({ rows = [], deal = null, shown = [] } = {}) {
  const total = pricedOffers(rows).filter((offer) => !isVaultOffer(offer)).length;
  const bestDeal = deal && !isVaultOffer(deal) ? 1 : 0;
  return total > bestDeal + shown.length ? total : 0;
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

/** Sell now is reachable when the row names a best order the visitor did not post. */
export function buyOfferSellable(row, mine = []) {
  return Boolean(row?.best_order_id) && !mine.includes(row.best_order_id);
}

/** Whole rows of `row` px (plus `gap`) that fit `space`. */
function rowsThatFit(space, { row, gap }) {
  if (space < row) return 0;
  return Math.floor((space + gap) / (row + gap));
}

/** Alternate rows between the two lists, so even a tight layout shows both. */
function share(sellers, offers, rows) {
  const s = [];
  const o = [];
  for (let index = 0; index < rows; index += 1) {
    if (index % 2 === 0 && s.length < sellers.length) s.push(sellers[s.length]);
    else if (o.length < offers.length) o.push(offers[o.length]);
    else if (s.length < sellers.length) s.push(sellers[s.length]);
    else break;
  }
  return { sellers: s, offers: o };
}

/** Rows for the blocks that show: two headings when both lists have rows, else one. */
function pack(sellers, offers, available, metrics, withMore) {
  const budget = (blocks) => available
    - blocks * metrics.head
    - Math.max(0, blocks - 1) * metrics.block
    - (withMore ? metrics.more : 0);
  const blocks = (sellers.length ? 1 : 0) + (offers.length ? 1 : 0);
  if (!blocks) return { sellers: [], offers: [] };
  if (blocks === 1) return share(sellers, offers, rowsThatFit(budget(1), metrics));
  const both = rowsThatFit(budget(2), metrics);
  if (both) return share(sellers, offers, both);
  // Two headings leave no room for a whole row: let one block pay for itself alone.
  return sellers.length
    ? share(sellers, [], rowsThatFit(budget(1), metrics))
    : share([], offers, rowsThatFit(budget(1), metrics));
}

/**
 * What the book shows in `available` px: whole rows only, the seller rows and the
 * buy offers alternating, plus the See all count. Every list without a row is
 * dropped, so a panel with no room looks exactly as it did before the book.
 */
export function planDealBook({
  available = 0,
  rows = [],
  deal = null,
  book = [],
  language = '',
  condition = '',
  card = null,
  max = DEAL_BOOK_MAX_ROWS,
  metrics = DEAL_BOOK_METRICS,
} = {}) {
  const sellers = otherSellerRows({ rows, deal, language, condition, card, max });
  const offers = buyOfferRows(book, { language, max });
  const more = (shown) => (shown.length ? seeAllListings({ rows, deal, shown }) : 0);

  let plan = pack(sellers, offers, available, metrics, false);
  if (more(plan.sellers)) {
    // The link under the seller rows costs height too, and when even that leaves
    // no row the sellers list goes with its heading and the offers take the space.
    plan = pack(sellers, offers, available, metrics, true);
    if (!plan.sellers.length) plan = pack([], offers, available, metrics, false);
  }
  return { ...plan, more: more(plan.sellers) };
}

/** The stacked desk has no spare height to measure: the caps alone decide the book. */
export function dealBookUncut({
  rows = [],
  deal = null,
  book = [],
  language = '',
  condition = '',
  card = null,
  max = DEAL_BOOK_MAX_ROWS,
} = {}) {
  const sellers = otherSellerRows({ rows, deal, language, condition, card, max });
  const offers = buyOfferRows(book, { language, max });
  return { sellers, offers, more: sellers.length ? seeAllListings({ rows, deal, shown: sellers }) : 0 };
}

/** The book for one viewport: measured whole rows where the column stretches, caps where it stacks. */
export function dealBookPlan({
  width = 0,
  available = 0,
  rows = [],
  deal = null,
  book = [],
  language = '',
  condition = '',
  card = null,
  metrics = DEAL_BOOK_METRICS,
} = {}) {
  const facet = { rows, deal, book, language, condition, card };
  if (!dealBookMeasured(width)) return dealBookUncut({ ...facet, max: dealBookRows(width) });
  return planDealBook({ ...facet, available, metrics });
}
