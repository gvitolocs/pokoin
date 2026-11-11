import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUY_ORDER_LANGS,
  bestBid,
  beatPricePkn,
  defaultOfferSettings,
  offerBody,
  offerPriceInput,
  offerPriceLabel,
  offerPricePkn,
  offerSummary,
  beatStepPkn,
  offerBarModel,
  offerPrefill,
  buyerNameOf,
  bidsByCondition,
  crossesAsk,
  errorMessage,
  expiryLabel,
  offerLanguages,
  selectionBid,
  orderStateLabel,
  validateBuyOrder,
} from './buy-orders.js';
import { formatFiatFromPkn, listingPriceToPkn } from './pkn.js';

const book = [
  { condition: 'NM', language: 'EN', reverse: false, first_edition: false, best_price_pkn: 120, quantity: 3, orders: 2 },
  { condition: 'NM', language: 'EN', reverse: true, first_edition: false, best_price_pkn: 150, quantity: 1, orders: 1 },
  { condition: 'SP', language: 'EN', reverse: false, first_edition: false, best_price_pkn: 90, quantity: 2, orders: 1 },
  { condition: 'NM', language: 'JP', reverse: false, first_edition: false, best_price_pkn: 80, quantity: 1, orders: 1 },
];

test('bestBid matches the whole facet tuple', () => {
  assert.equal(bestBid(book, { condition: 'NM', language: 'EN' }).best_price_pkn, 120);
  assert.equal(bestBid(book, { condition: 'NM', language: 'en', reverse: true }).best_price_pkn, 150);
  assert.equal(bestBid(book, { condition: 'NM', language: 'EN', firstEdition: true }), null);
  assert.equal(bestBid(book, { condition: 'PL', language: 'EN' }), null);
  assert.equal(bestBid(null, { condition: 'NM', language: 'EN' }), null);
});

test('bidsByCondition keeps the best price per condition for one language', () => {
  assert.deepEqual(bidsByCondition(book, 'EN'), [
    { condition: 'NM', bestPricePkn: 150, quantity: 1 },
    { condition: 'SP', bestPricePkn: 90, quantity: 2 },
  ]);
  assert.deepEqual(bidsByCondition(book, 'FR'), []);
  assert.deepEqual(bidsByCondition(undefined, 'EN'), []);
});

test('orderStateLabel names the four states', () => {
  assert.equal(orderStateLabel('open'), 'Open');
  assert.equal(orderStateLabel('filled'), 'Filled');
  assert.equal(orderStateLabel('expired'), 'Expired');
  assert.equal(orderStateLabel('cancelled'), 'Cancelled');
});

test('expiryLabel counts down and handles no expiry', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(expiryLabel(null, now), 'Until cancelled');
  assert.equal(expiryLabel('2026-11-14T12:00:00Z', now), '3 days left');
  assert.equal(expiryLabel('2026-11-12T13:00:00Z', now), '1 day left');
  assert.equal(expiryLabel('2026-11-11T17:00:00Z', now), '5 hours left');
  assert.equal(expiryLabel('2026-11-11T12:20:00Z', now), 'Less than an hour left');
  assert.equal(expiryLabel('2026-11-11T11:59:00Z', now), 'Expired');
});

test('validateBuyOrder mirrors the server rules', () => {
  const good = { card_id: 'c1', condition: 'NM', language: 'EN', price_pkn: 100, quantity: 2, days: 30 };
  assert.equal(validateBuyOrder(good).ok, true);
  assert.equal(validateBuyOrder({ ...good, days: null }).ok, true);
  assert.equal(validateBuyOrder({ ...good, days: 5 }).errors.days.length > 0, true);
  assert.ok(validateBuyOrder({ ...good, price_pkn: 0 }).errors.price_pkn);
  assert.ok(validateBuyOrder({ ...good, quantity: 11 }).errors.quantity);
  assert.ok(validateBuyOrder({ ...good, quantity: 1.5 }).errors.quantity);
  assert.ok(validateBuyOrder({ ...good, condition: 'Mint' }).errors.condition);
  assert.ok(validateBuyOrder({ ...good, language: 'XX' }).errors.language);
  assert.ok(validateBuyOrder({ ...good, card_id: '' }).errors.card_id);
  assert.ok(validateBuyOrder({ ...good, price_pkn: 2_000_000_000 }).errors.price_pkn);
  const { days: _days, ...noDays } = good;
  assert.ok(validateBuyOrder(noDays).errors.days, 'the API requires the days key');
});

test('errorMessage turns each code into a sentence', () => {
  for (const code of ['duplicate_buy_order', 'too_many_buy_orders', 'own_buy_order', 'not_open', 'quantity_exceeds_remaining']) {
    assert.match(errorMessage(code), /\.$/);
  }
  assert.match(errorMessage(new Error('not_open')), /no longer open/);
  assert.equal(errorMessage('Seller cannot list yet.'), 'Seller cannot list yet.');
  assert.match(errorMessage('something_odd'), /Something went wrong/);
  assert.match(errorMessage(''), /Something went wrong/);
});

test('crossesAsk is true at or above the cheapest listing', () => {
  assert.equal(crossesAsk(100, 100), true);
  assert.equal(crossesAsk(120, 100), true);
  assert.equal(crossesAsk(99, 100), false);
  assert.equal(crossesAsk(100, null), false);
  assert.equal(crossesAsk(100, 0), false);
});

test('selectionBid takes the top price across variants and sums the copies', () => {
  const row = selectionBid(book, { condition: 'NM', language: 'EN' });
  assert.equal(row.best_price_pkn, 150);
  assert.equal(row.quantity, 4);
  assert.equal(row.orders, 3);
  assert.equal(selectionBid(book, { condition: 'PL', language: 'EN' }), null);
});

test('every error code the API returns has a plain sentence', () => {
  const codes = [
    'invalid_cursor', 'invalid_sort', 'not_editable', 'quantity_below_filled', 'buy_order_changed',
    'nothing_to_update', 'rate_limited', 'invalid_body', 'invalid_card', 'invalid_condition',
    'invalid_language', 'invalid_price', 'invalid_quantity', 'invalid_days', 'duplicate_buy_order',
    'too_many_buy_orders', 'own_buy_order', 'not_open', 'quantity_exceeds_remaining', 'not_found',
  ];
  for (const code of codes) {
    const text = errorMessage(new Error(code));
    assert.notEqual(text, 'Something went wrong. Try again.', code);
    assert.ok(!/_/.test(text), code);
  }
});

test('the language list is the API list (price_export::LANGUAGES) and the form never offers another', () => {
  assert.deepEqual(
    [...BUY_ORDER_LANGS].sort(),
    ['DE', 'EN', 'ES', 'FR', 'ID', 'IT', 'JP', 'KO', 'NL', 'PL', 'PT', 'RU', 'TH', 'VI', 'ZH', 'ZHT'],
  );
  assert.deepEqual(offerLanguages(['en', 'XX', 'jp', 'EN', '', null]), ['EN', 'JP']);
});

test('buyerNameOf drops the seller fallback name', () => {
  assert.equal(buyerNameOf(' Mira '), 'Mira');
  assert.equal(buyerNameOf('Pokoin seller'), '');
});

test('offerBarModel says Make offer without an offer and Beat offer with one', () => {
  assert.deepEqual(offerBarModel(null), { hasOffer: false, button: 'Make offer', title: 'No offers yet' });
  assert.equal(offerBarModel(selectionBid(book, { condition: 'PL', language: 'EN' })).button, 'Make offer');
  const nm = offerBarModel(selectionBid(book, { condition: 'NM', language: 'EN' }));
  assert.deepEqual(nm, { hasOffer: true, button: 'Beat offer', title: '4 wanted · 3 buyers' });
  assert.equal(offerBarModel({ best_price_pkn: 50, quantity: 1, orders: 1 }).title, '1 wanted · 1 buyer');
});

test('offerPrefill is one step above the best offer, empty without one', () => {
  assert.equal(beatStepPkn(50), 1);
  assert.equal(beatStepPkn(4200), 42);
  assert.equal(beatStepPkn(0), 1);
  assert.equal(offerPrefill({ best_price_pkn: 50 }), '51');
  assert.equal(offerPrefill({ best_price_pkn: 4200 }), '4242');
  assert.equal(offerPrefill(null), '');
  assert.equal(offerPrefill({ best_price_pkn: 'x' }), '');
});

test('the offer price field converts with the listing form helpers and round-trips', () => {
  // 0.98 DKK → PKN → shown again as 0.98 DKK (the listing form's own 2-decimal rounding).
  const pkn = offerPricePkn('0.98', 'DKK');
  assert.equal(pkn, listingPriceToPkn('0.98', 'DKK'));
  assert.equal(offerPriceInput(pkn, 'DKK'), '0.98');
  for (const typed of ['0.98', '2.64', '15', '123.45']) {
    for (const currency of ['DKK', 'EUR', 'USD']) {
      assert.equal(offerPriceInput(offerPricePkn(typed, currency), currency), String(Number(typed)), `${typed} ${currency}`);
    }
  }
  // Decimal comma, as sellers type it.
  assert.equal(offerPricePkn('2,64', 'DKK'), offerPricePkn('2.64', 'DKK'));
  // PKN is PKN.
  assert.equal(offerPricePkn('120', 'PKN'), 120);
  assert.equal(offerPriceInput(120, 'PKN'), '120');
  assert.equal(offerPricePkn('', 'DKK'), null);
  assert.equal(offerPricePkn('abc', 'EUR'), null);
});

test('prefill, labels and Beat offer text use the visitor currency', () => {
  const bid = { best_price_pkn: 100 };
  assert.equal(beatPricePkn(bid), 101);
  assert.equal(beatPricePkn(null), null);
  assert.equal(offerPriceInput(beatPricePkn(bid), 'DKK'), '3.79');
  assert.equal(offerPriceLabel(101, 'DKK'), formatFiatFromPkn(101, 'DKK')); // the label formatter the listing form's "Lists at" uses
  assert.equal(offerPriceLabel(101, 'PKN'), '101 PKN');
  assert.equal(offerPriceLabel(101, 'USD'), '$0.51');
  const settings = defaultOfferSettings({ condition: 'NM', language: 'en' });
  assert.deepEqual(settings, { quantity: '1', condition: 'NM', language: 'EN', days: '30', reverse: false, firstEdition: false });
  assert.equal(offerSummary(101, settings, 'DKK'), 'Offer 3.83 DKK for 1 copy, Near Mint, EN, 30 days');
  assert.equal(
    offerSummary(101, { ...settings, quantity: '3', days: 'null', reverse: true }, 'PKN'),
    'Offer 101 PKN for 3 copies, Near Mint, EN, Until cancelled, Reverse',
  );
  assert.deepEqual(defaultOfferSettings({ condition: 'XX', language: 'zz' }), { ...settings });
});

test('offerBody carries the settings and null days for until cancelled', () => {
  const settings = { ...defaultOfferSettings({ condition: 'SP', language: 'JP' }), days: 'null', firstEdition: true };
  const body = offerBody({ cardId: 7, pricePkn: 55, settings, buyerName: 'Ann', card: { name: 'Mew', set: 'Fossil', number: '5/62' } });
  assert.equal(body.card_id, '7');
  assert.equal(body.days, null);
  assert.equal(body.first_edition, true);
  assert.equal(body.reverse, false);
  assert.equal(body.quantity, 1);
  assert.equal(validateBuyOrder(body).ok, true);
});
