import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEAL_BOOK_MAX_ROWS_PHONE,
  DEAL_BOOK_MAX_ROWS,
  buyOfferRows,
  buyOfferSellable,
  buyOfferTotal,
  cheapestRows,
  dealBookCount,
  dealBookRows,
  listingTotal,
  seeAllListings,
  seeAllOffers,
  deskOfferRows,
} from './deal-book.js';
import { VAULT_SELLER_UID } from './vault.js';

test('the Buy offers cell lists the picked language first, then the other languages, never an empty cell over real offers', () => {
  const book = [
    { condition: 'SP', language: 'EN', best_price_pkn: 900, quantity: 1, orders: 1, best_order_id: 'en-sp' },
    { condition: 'NM', language: 'EN', best_price_pkn: 1000, quantity: 2, orders: 1, best_order_id: 'en-nm' },
    { condition: 'NM', language: 'JP', best_price_pkn: 5000, quantity: 1, orders: 1, best_order_id: 'jp-nm' },
    { condition: 'MP', language: 'DE', best_price_pkn: 2000, quantity: 1, orders: 1, best_order_id: 'de-mp' },
  ];
  const key = (rows) => rows.map((row) => `${row.language}:${row.condition}`);
  // EN picked: its two rows by price, then the others by price.
  assert.deepEqual(key(deskOfferRows(book, { language: 'EN', max: 0 })), ['EN:NM', 'EN:SP', 'JP:NM', 'DE:MP']);
  assert.deepEqual(key(deskOfferRows(book, { language: 'en' })), ['EN:NM', 'EN:SP', 'JP:NM'], 'capped at three');
  // IT picked, nothing in IT: the offers that exist are still shown (this was "0 of 2" over an empty cell).
  const only = [book[0], book[1]];
  assert.deepEqual(key(deskOfferRows(only, { language: 'IT' })), ['EN:NM', 'EN:SP']);
  assert.equal(deskOfferRows(only, { language: 'IT' })[0].best_order_id, 'en-nm', 'the row names its order, so its owner can delete it');
  assert.deepEqual(deskOfferRows([], { language: 'IT' }), []);
  assert.deepEqual(deskOfferRows(null, { language: 'IT' }), []);
});

const EN_NM = { language: 'EN', condition: 'NM' };

/** Pokoin listings; the id follows the price, so rows never collide. */
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
  // The cells size to their content now: a width of nothing is not a phone.
  assert.equal(dealBookRows(0), 3);
});

test('the cheapest three are the whole card, cheapest first, whatever the chips picked', () => {
  // Deliberately unsorted, and mixing grades and languages on purpose.
  const rows = [
    { id: 'jp', pricePkn: 200, condition: 'NM', language: 'JP' },
    { id: 'nm', pricePkn: 100, condition: 'NM', language: 'EN' },
    { id: 'sp', pricePkn: 300, condition: 'SP', language: 'EN' },
    { id: 'mp', pricePkn: 400, condition: 'MP', language: 'EN' },
  ];
  assert.deepEqual(cheapestRows({ rows }).map((row) => row.id), ['nm', 'jp', 'sp'], 'capped at 3, price order only');
  assert.deepEqual(
    cheapestRows({ rows, ...EN_NM }).map((row) => row.id),
    ['nm', 'jp', 'sp'],
    'the selected facets never filter this summary',
  );
  assert.deepEqual(cheapestRows({ rows, max: 2 }).map((row) => row.id), ['nm', 'jp']);
  assert.deepEqual(cheapestRows({ rows, max: 0 }).map((row) => row.id), ['nm', 'jp', 'sp', 'mp'], 'max 0 counts them all');
});

test('the summary is the price band listing too, but never the Vault or an unpriced row', () => {
  const rows = [
    vault(10),
    { id: 'free', pricePkn: 0, condition: 'NM', language: 'EN' },
    { id: 'band', pricePkn: 20, condition: 'NM', language: 'EN' },
    { id: 'hi', pricePkn: 30, condition: 'LP', language: 'EN' },
  ];
  const shown = cheapestRows({ rows });
  assert.deepEqual(shown.map((row) => row.id), ['band', 'hi'], 'any grade and any language ranks, by price');
  assert.equal(shown[0], rows[2], 'the cheapest listing is the one the band shows: it is not skipped twice');
});

test('See all counts every non-Vault listing and stays hidden when the cell shows them all', () => {
  const rows = listings(100, 200, 300, 400, 500, 600);
  const shown = cheapestRows({ rows });
  assert.equal(shown.length, 3);
  assert.equal(seeAllListings({ rows, shown }), 6, 'three rows leave three unseen');
  assert.equal(seeAllListings({ rows, shown: cheapestRows({ rows, max: 0 }) }), 0, 'nothing hidden, nothing to see');
  assert.equal(seeAllListings({ rows: listings(100, 200), shown: cheapestRows({ rows: listings(100, 200) }) }), 0);
  assert.equal(seeAllListings({ rows: [vault(10)], shown: [] }), 0, 'Vault stock is not the Shop');
  assert.equal(seeAllListings({ rows: [], shown: [] }), 0, 'a card with no listings has no Shop to open');
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
  assert.deepEqual(buyOfferRows([], { language: 'EN' }), [], 'no book, no rows: the cell shows its one empty line');
});

test('Sell now only appears on an offer the visitor did not post themselves', () => {
  const row = { condition: 'NM', best_order_id: 'o1', best_remaining: 2 };
  assert.equal(buyOfferSellable(row, []), true);
  assert.equal(buyOfferSellable(row, ['other']), true);
  assert.equal(buyOfferSellable(row, ['o1']), false, 'never offer my own order back to me');
  assert.equal(buyOfferSellable({ condition: 'NM' }, []), false, 'a facet total has no order to sell into');
});

/** A hundred of something, in the shape the preview pile sends it. */
const many = (n, make) => Array.from({ length: n }, (_, index) => make(index));

test('a hundred listings are still three rows, one See all and a counted title', () => {
  const rows = many(100, (i) => ({
    id: `l${i}`, pricePkn: 9000 - i * 60, condition: 'NM', language: 'EN', sellerUid: `s${i}`,
  }));
  assert.equal(listingTotal({ rows }), 100);
  const shown = cheapestRows({ rows });
  assert.equal(shown.length, DEAL_BOOK_MAX_ROWS, 'the cell never grows with the pile');
  assert.equal(seeAllListings({ rows, shown }), 100);
  assert.equal(dealBookCount(shown.length, listingTotal({ rows })), '3 of 100');
  const phone = cheapestRows({ rows, max: DEAL_BOOK_MAX_ROWS_PHONE });
  assert.equal(dealBookCount(phone.length, listingTotal({ rows })), '2 of 100');
  assert.equal(seeAllOffers([], []), 0, 'no offers, no link');
  // Everything visible: the title counts what it shows and asks for no link.
  const three = rows.slice(0, 3);
  assert.equal(dealBookCount(cheapestRows({ rows: three }).length, listingTotal({ rows: three })), '3');
  assert.equal(seeAllListings({ rows: three, shown: cheapestRows({ rows: three }) }), 0);
});

test('a hundred offers are still three rows, one See all and a counted title', () => {
  // The book aggregates one row per facet: 25 of them, four orders each.
  const book = many(25, (i) => ({
    condition: ['NM', 'SP', 'MP', 'PL', 'Poor'][i % 5],
    language: ['EN', 'JP', 'IT', 'DE', 'FR'][(i / 5) | 0],
    best_price_pkn: 4000 - i * 30,
    quantity: 4,
    orders: 4,
  }));
  assert.equal(buyOfferTotal(book), 100, 'the card has every offer, in every facet');
  const shown = buyOfferRows(book, { language: 'EN' });
  assert.equal(shown.length, DEAL_BOOK_MAX_ROWS, 'the cell never grows with the pile');
  assert.equal(seeAllOffers(book, shown), 100);
  assert.equal(dealBookCount(shown.length, buyOfferTotal(book)), '3 of 100');
  assert.equal(
    buyOfferRows(book, { language: 'EN', max: DEAL_BOOK_MAX_ROWS_PHONE }).length,
    DEAL_BOOK_MAX_ROWS_PHONE,
  );
  // A facet the cell already shows whole needs no link and no of-total.
  const one = [{ condition: 'NM', language: 'EN', best_price_pkn: 900, quantity: 1, orders: 1 }];
  assert.equal(seeAllOffers(one, buyOfferRows(one, { language: 'EN' })), 0);
  assert.equal(dealBookCount(buyOfferRows(one, { language: 'EN' }).length, buyOfferTotal(one)), '1');
});
