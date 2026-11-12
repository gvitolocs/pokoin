import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEAL_BOOK_METRICS,
  DEAL_BOOK_MAX_ROWS_PHONE,
  DEAL_BOOK_MAX_ROWS,
  buyOfferRows,
  buyOfferSellable,
  dealBookMeasured,
  dealBookRows,
  otherSellerRows,
  planDealBook,
  seeAllListings,
} from './deal-book.js';
import { VAULT_SELLER_UID } from './vault.js';

// The same numbers styles.css sizes .deal-book from.
const METRICS = { row: 50, gap: 6, head: 20, more: 24, block: 14 };
const EN_NM = { language: 'EN', condition: 'NM' };

/** Pokoin listings, cheapest first by price; the id follows the price, so rows never collide. */
function listings(...prices) {
  return prices.map((price) => ({
    id: `l${price}`,
    pricePkn: price,
    condition: 'NM',
    language: 'EN',
    sellerUid: `seller-${price}`,
    sellerName: `seller${price}`,
    quantityAvailable: 1,
  }));
}

const vault = (price) => ({ id: `v${price}`, pricePkn: price, condition: 'NM', language: 'EN', sellerUid: VAULT_SELLER_UID });

test('the caps are three desktop rows and two on a phone', () => {
  assert.equal(DEAL_BOOK_MAX_ROWS, 3);
  assert.equal(DEAL_BOOK_MAX_ROWS_PHONE, 2);
  assert.equal(dealBookRows(1360), 3);
  assert.equal(dealBookRows(721), 3);
  assert.equal(dealBookRows(720), 2);
  assert.equal(dealBookRows(390), 2);
  // Only the stretched three-column desk has spare height to measure.
  assert.equal(dealBookMeasured(1360), true);
  assert.equal(dealBookMeasured(1100), false);
});

test('other sellers are the facet the chips picked, cheapest first, without the Best Deal row', () => {
  const rows = listings(300, 100, 500, 200);
  const facet = otherSellerRows({ rows, ...EN_NM });
  assert.deepEqual(facet.map((row) => row.pricePkn), [100, 200, 300], 'cheapest first, capped at 3');
  assert.deepEqual(
    otherSellerRows({ rows, deal: facet[0], ...EN_NM }).map((row) => row.pricePkn),
    [200, 300, 500],
    'the listing Best Deal shows is never repeated',
  );
  assert.deepEqual(
    otherSellerRows({ rows, deal: facet[0], max: 2, ...EN_NM }).map((row) => row.pricePkn),
    [200, 300],
  );
});

test('other sellers skip the Vault, other grades and other languages', () => {
  const rows = [
    vault(10),
    { id: 'jp', pricePkn: 20, condition: 'NM', language: 'JP' },
    { id: 'sp', pricePkn: 30, condition: 'SP', language: 'EN' },
    { id: 'free', pricePkn: 0, condition: 'NM', language: 'EN' },
    { id: 'en', pricePkn: 40, condition: 'NM', language: 'EN' },
  ];
  assert.deepEqual(otherSellerRows({ rows, ...EN_NM }).map((row) => row.id), ['en'], 'unpriced rows are not sellers');
  assert.deepEqual(otherSellerRows({ rows, language: 'EN', condition: 'SP' }).map((row) => row.id), ['sp']);
});

test('other sellers read grades and languages like the chips do', () => {
  // Lightly Played is the chips' SP; JA is JP; a bare CardTrader language is the print language.
  const rows = [
    { id: 'lp', pricePkn: 10, condition: 'Lightly Played', language: 'EN' },
    { id: 'ja', pricePkn: 20, condition: 'NM', language: 'JA' },
    { id: 'bare', pricePkn: 30, condition: 'Near Mint', language: '' },
  ];
  assert.deepEqual(otherSellerRows({ rows, language: 'EN', condition: 'SP' }).map((row) => row.id), ['lp']);
  assert.deepEqual(otherSellerRows({ rows, language: 'JP', condition: 'NM' }).map((row) => row.id), ['ja']);
  assert.deepEqual(
    otherSellerRows({ rows, language: 'JP', condition: 'NM', card: { nationality: 'japanese' } }).map((row) => row.id),
    ['ja', 'bare'],
    'a row with no CardTrader language is the Japanese print, and price still orders the list',
  );
});

test('See all counts every non-Vault listing and stays hidden when the panel already shows them', () => {
  const rows = listings(100, 200, 300, 400, 500, 600);
  const deal = rows[0];
  const shown = otherSellerRows({ rows, deal, max: 0, ...EN_NM });
  assert.equal(seeAllListings({ rows, deal, shown: [] }), 6);
  assert.equal(seeAllListings({ rows, deal, shown: shown.slice(0, 3) }), 6, 'three rows leave two unseen');
  assert.equal(seeAllListings({ rows, deal, shown }), 0, 'Best Deal plus every other seller leaves nothing to see');
  assert.equal(seeAllListings({ rows: [vault(10)], deal: null, shown: [] }), 0, 'Vault stock is not the Shop');
});

test('buy offers are one row per condition, best price first', () => {
  const book = [
    { condition: 'SP', language: 'EN', best_price_pkn: 900, quantity: 1, orders: 1 },
    { condition: 'NM', language: 'EN', best_price_pkn: 1000, quantity: 2, orders: 1 },
    { condition: 'NM', language: 'EN', reverse: true, best_price_pkn: 1200, quantity: 3, orders: 2 },
    { condition: 'NM', language: 'JP', best_price_pkn: 5000, quantity: 1, orders: 1 },
    { condition: 'Poor', language: 'EN', best_price_pkn: 400, quantity: 4, orders: 1 },
  ];
  const rows = buyOfferRows(book, { language: 'EN' });
  assert.deepEqual(rows.map((row) => row.condition), ['NM', 'SP', 'Poor'], 'best price first');
  assert.equal(rows[0].best_price_pkn, 1200, 'reverse variants aggregate exactly like the offer bar');
  assert.equal(rows[0].quantity, 5, 'the wanted total adds the variants');
  assert.deepEqual(buyOfferRows(book, { language: 'EN', max: 2 }).map((row) => row.condition), ['NM', 'SP']);
  assert.deepEqual(buyOfferRows([], { language: 'EN' }), []);
});

test('Sell now only appears on an offer the visitor did not post themselves', () => {
  const row = { condition: 'NM', best_order_id: 'o1', best_remaining: 2 };
  assert.equal(buyOfferSellable(row, []), true);
  assert.equal(buyOfferSellable(row, ['other']), true);
  assert.equal(buyOfferSellable(row, ['o1']), false, 'never offer my own order back to me');
  assert.equal(buyOfferSellable({ condition: 'NM' }, []), false, 'a facet total has no order to sell into');
});

test('the plan fills the spare height with whole rows of both lists', () => {
  const rows = listings(100, 200, 300, 400, 500);
  const book = [
    { condition: 'NM', language: 'EN', best_price_pkn: 1000, quantity: 2, orders: 1, best_order_id: 'o1', best_remaining: 1 },
    { condition: 'NM', language: 'EN', reverse: true, best_price_pkn: 1200, quantity: 3, orders: 2 },
    { condition: 'SP', language: 'EN', best_price_pkn: 900, quantity: 1, orders: 1 },
    { condition: 'MP', language: 'EN', best_price_pkn: 800, quantity: 1, orders: 1 },
    { condition: 'PL', language: 'EN', best_price_pkn: 700, quantity: 1, orders: 1 },
  ];
  const plan = (available) => planDealBook({ available, rows, deal: rows[0], book, ...EN_NM, metrics: METRICS });
  /** `rows_` rows of two blocks, the gap between them and an optional See all line. */
  const room = (rows_, link = 0) => 2 * METRICS.head + METRICS.block + link + rows_ * (METRICS.row + METRICS.gap);
  const shape = (p) => [p.sellers.length, p.offers.length, p.more];

  assert.deepEqual(shape(plan(room(6, METRICS.more))), [3, 3, 5], 'room for three and three');
  assert.deepEqual(shape(plan(room(5))), [2, 2, 5], 'one row short: both lists lose one');
  assert.deepEqual(shape(plan(room(2))), [1, 0, 5], 'the See all line costs the offers their row');
  assert.deepEqual(plan(24), { sellers: [], offers: [], more: 0 }, 'no space, no book');
  assert.equal(plan(METRICS.head + METRICS.row - 1).sellers.length, 0, 'never a cut-off row');
});

test('the plan reserves the See all line instead of hiding listings', () => {
  const rows = listings(100, 200, 300, 400);
  const book = [{ condition: 'NM', language: 'EN', best_price_pkn: 1000, quantity: 1, orders: 1, best_order_id: 'o1', best_remaining: 1 }];
  const plan = (available) => planDealBook({ available, rows, deal: rows[0], book, ...EN_NM, metrics: METRICS });
  const shape = (p) => [p.sellers.length, p.offers.length, p.more];
  // Two headings + two rows: the See all line costs the offers its row.
  assert.deepEqual(shape(plan(2 * METRICS.head + METRICS.block + METRICS.more + 3 * (METRICS.row + METRICS.gap))), [2, 1, 4]);
  // A seller row + heading + link, but no room for the offers heading: no partial row.
  assert.deepEqual(shape(plan(METRICS.head + METRICS.row + METRICS.gap)), [0, 1, 0],
    'a list with no row is dropped, so the other list takes its space');
});

test('a list that covers the whole card shows alone, with no See all line', () => {
  const rows = listings(100, 200);
  const book = [{ condition: 'NM', language: 'EN', best_price_pkn: 1000, quantity: 1, orders: 1 }];
  const p = planDealBook({
    available: METRICS.head + METRICS.row + METRICS.gap,
    rows,
    deal: rows[0],
    book,
    ...EN_NM,
    metrics: METRICS,
  });
  assert.deepEqual([p.sellers.length, p.offers.length, p.more], [1, 0, 0], 'the two headings do not both pay');
});

test('the plan falls back to the shared row heights when the desk does not measure them', () => {
  assert.deepEqual(DEAL_BOOK_METRICS, METRICS);
  const rows = listings(100, 200);
  const got = planDealBook({ available: 400, rows, deal: rows[0], ...EN_NM });
  assert.deepEqual(got.sellers.map((row) => row.pricePkn), [200]);
  assert.equal(got.offers.length, 0, 'no book, no offers');
  assert.equal(got.more, 0, 'Best Deal and this row cover the card');
});
