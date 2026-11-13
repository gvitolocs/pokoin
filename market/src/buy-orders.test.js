import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUY_ORDER_LANGS,
  fetchBuyBook,
  BUYER_MESSAGE_MAX,
  bestBid,
  buyerMessageError,
  buyerMessageLength,
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
  sellIntoBuyOrder,
  sellToHouse,
  storedOfferUnit,
  orderStateLabel,
  validateBuyOrder,
  withHouseOffer,
  HOUSE_OFFER_PKN,
  offerUnit,
  OFFER_UNIT_KEY,
  BOOK_CACHE_KEY,
  readBookCache,
  writeBookCache,
  sellableBid,
} from './buy-orders.js';

/** Every request the calls below make, with the body they posted. */
async function captureBodies(run) {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = { location: { hostname: 'pokoin.com', pathname: '/marketplace/en/cards/1/pikachu', search: '' } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
    const text = JSON.stringify({ listing_id: 'L1', buy_order: { id: 'o1' } });
    return {
      ok: true,
      status: 201,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : '') },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  return calls;
}

test('the note to the buyer counts code points and trims what is not a note', () => {
  assert.equal(BUYER_MESSAGE_MAX, 240);
  assert.equal(buyerMessageLength(''), 0);
  assert.equal(buyerMessageLength('   \n '), 0, 'spaces and a lone break are no note at all');
  assert.equal(buyerMessageLength('Sleeved since opening'), 21);
  assert.equal(buyerMessageLength('  padded  '), 6, 'the ends the API never sees are not counted');
  assert.equal(buyerMessageLength('a\r\nb'), 3, 'a Windows break is the one character the server counts');
  assert.equal(buyerMessageLength('🃏🃏🃏'), 3, 'an emoji is one code point, not two');
  assert.equal(buyerMessageLength('x'.repeat(240)), 240);
  assert.equal(buyerMessageLength('x'.repeat(241)), 241);
});

test('buyerMessageError is silent on a sendable note, plain on one that is not', () => {
  const tooLong = "That note is too long or has characters we can't send.";
  assert.equal(buyerMessageError(''), '');
  assert.equal(buyerMessageError('   '), '');
  assert.equal(buyerMessageError('Sleeved since opening, ready to ship.'), '');
  assert.equal(buyerMessageError('a\nb'), '', 'a line break sends');
  assert.equal(buyerMessageError('x'.repeat(240)), '', '240 is the limit, not one past it');
  assert.equal(buyerMessageError(`${'x'.repeat(241)}  `), tooLong, 'padded over the limit is still over');
  assert.equal(buyerMessageError('a\tb'), tooLong, 'a tab is not sendable');
  assert.equal(buyerMessageError('a\u0000b'), tooLong);
  assert.equal(buyerMessageError('a\u0007b'), tooLong, 'a bell is a control character');
  assert.match(buyerMessageError('x'.repeat(300)), /\.$/, 'the sentence ends like every other one');
});

test('the sell bodies carry the note only when there is something to send', async () => {
  const note = 'Sleeved since opening, ready to ship.';
  const calls = await captureBodies(async () => {
    await sellIntoBuyOrder('o 1', 2, 'tok', note);
    await sellIntoBuyOrder('o1', 1, 'tok');
    await sellIntoBuyOrder('o1', 1, 'tok', '   ');
    await sellIntoBuyOrder('o1', 1, 'tok', `${note}\r\n`);
    await sellToHouse({
      cardId: 42,
      condition: 'NM',
      language: 'EN',
      reverse: true,
      firstEdition: false,
      quantity: 3,
      card: { name: 'Pikachu', imageUrl: '/x.png', set: 'Base', number: '25/102' },
      buyerMessage: note,
    }, 'tok');
    await sellToHouse({ cardId: 42, condition: 'SP', language: 'JP', quantity: 1 }, 'tok');
  });
  assert.ok(calls[0].url.endsWith('/api/marketplace-buy-orders/o%201/sell'), calls[0].url);
  assert.ok(calls[4].url.endsWith('/api/marketplace-buy-orders/house/sell'), calls[4].url);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { quantity: 2, buyer_message: note });
  assert.deepEqual(calls[1].body, { quantity: 1 }, 'no note at all: the key is absent, not empty');
  assert.deepEqual(calls[2].body, { quantity: 1 }, 'a blank note is no note');
  assert.deepEqual(calls[3].body, { quantity: 1, buyer_message: note }, 'the break the server folds is not sent');
  assert.deepEqual(calls[4].body, {
    card_id: '42',
    condition: 'NM',
    language: 'EN',
    reverse: true,
    first_edition: false,
    quantity: 3,
    card_name: 'Pikachu',
    card_image_url: '/x.png',
    set_name: 'Base',
    collector_number: '25/102',
    buyer_message: note,
  });
  assert.equal('buyer_message' in calls[5].body, false, 'the house sell sends no note when there is none');
});

test('a lone carriage return is folded to a line break like the server does', async () => {
  assert.equal(buyerMessageError('a\rb'), '');
  assert.equal(buyerMessageLength('a\rb'), 3);
  const calls = await captureBodies(async () => {
    await sellIntoBuyOrder('o1', 1, 'tok', 'a\rb');
  });
  assert.deepEqual(calls[0].body, { quantity: 1, buyer_message: 'a\nb' });
});

test('the offer unit of a surface that did not open the popup is the device choice', () => {
  const data = new Map([[OFFER_UNIT_KEY, 'PKN']]);
  const storage = { getItem: (key) => (data.has(key) ? data.get(key) : null) };
  assert.equal(storedOfferUnit('DKK', { storage }), 'PKN');
  data.set(OFFER_UNIT_KEY, 'dkk');
  assert.equal(storedOfferUnit('DKK', { storage }), 'DKK', 'only PKN is a choice');
  data.delete(OFFER_UNIT_KEY);
  assert.equal(storedOfferUnit('DKK', { storage }), 'DKK');
  assert.equal(storedOfferUnit('', { storage }), 'PKN', 'no currency yet: PKN');
  const blocked = { getItem: () => { throw new Error('denied'); } };
  assert.equal(storedOfferUnit('USD', { storage: blocked }), 'USD', 'a blocked store keeps the local currency');
  assert.equal(storedOfferUnit('USD'), 'USD', 'no localStorage at all: the local currency');
});

test('the last book of a card is kept on the device for the next paint', () => {
  const data = new Map();
  const storage = { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
  const rows = [{ condition: 'NM', language: 'EN', best_price_pkn: 40, quantity: 1, orders: 1 }];
  const t0 = 1_800_000_000_000;
  assert.equal(readBookCache('42', { storage, now: t0 }), null, 'nothing stored yet');
  writeBookCache('42', rows, { storage, now: t0 });
  assert.deepEqual(readBookCache('42', { storage, now: t0 + 60_000 }), rows);
  assert.deepEqual(readBookCache(42, { storage, now: t0 + 60_000 }), rows, 'a numeric id reads the same entry');
  // An empty book is a real answer and is kept; a book older than 30 minutes is not painted.
  writeBookCache('43', [], { storage, now: t0 });
  assert.deepEqual(readBookCache('43', { storage, now: t0 + 1 }), []);
  assert.equal(readBookCache('42', { storage, now: t0 + 31 * 60_000 }), null);
  assert.equal(readBookCache('42', { storage, now: t0 - 5 }), null, 'a clock that went back does not trust the entry');
  // Bounded: only the 40 most recent cards are kept.
  for (let i = 0; i < 60; i += 1) writeBookCache(`c${i}`, rows, { storage, now: t0 + 1000 + i });
  const kept = Object.keys(JSON.parse(data.get(BOOK_CACHE_KEY)));
  assert.equal(kept.length, 40);
  assert.ok(kept.includes('c59') && !kept.includes('c0') && !kept.includes('42'));
  // Broken or blocked storage never throws and never invents a book.
  data.set(BOOK_CACHE_KEY, '{not json');
  assert.equal(readBookCache('c59', { storage, now: t0 }), null);
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readBookCache('1', { storage: blocked }), null);
  assert.doesNotThrow(() => writeBookCache('1', rows, { storage: blocked }));
  assert.doesNotThrow(() => writeBookCache('1', 'nope', { storage }));
  assert.equal(readBookCache('', { storage }), null);
});

test('every selection starts at the house offer of 1 PKN, shown in the visitor currency', () => {
  assert.equal(HOUSE_OFFER_PKN, 1);
  const real = { best_price_pkn: 120, quantity: 3, orders: 2, best_order_id: 'o1' };
  assert.equal(withHouseOffer(real), real, 'a buyer offer is kept as it is');
  for (const none of [null, undefined, {}, { best_price_pkn: 0 }, { best_price_pkn: 'x' }]) {
    const house = withHouseOffer(none);
    assert.equal(house.best_price_pkn, 1);
    assert.equal(house.house, true);
    assert.equal(house.best_order_id, undefined, 'nothing can be sold into the house offer');
  }
  const model = offerBarModel(withHouseOffer(null));
  assert.equal(model.hasOffer, true);
  assert.equal(model.button, 'Beat offer');
  assert.match(model.title, /starting offer: 1 PKN/);
  // Beat offer on the floor is the smallest step above it, and the bar's amount is the floor converted.
  assert.equal(beatPricePkn(withHouseOffer(null)), 2);
  assert.equal(offerPriceLabel(HOUSE_OFFER_PKN, 'PKN'), '1 PKN');
  assert.equal(offerPriceLabel(HOUSE_OFFER_PKN, 'USD'), '$0.005');
});

test('offers under ten cents keep their sub-cent digits, so 1 PKN and 2 PKN read differently', () => {
  assert.equal(offerPriceLabel(1, 'USD'), '$0.005');
  assert.equal(offerPriceLabel(2, 'USD'), '$0.01');
  assert.equal(offerPriceLabel(3, 'EUR'), '€0.015');
  assert.equal(offerPriceLabel(1, 'DKK'), '0.0375 DKK');
  // From ten cents up the usual two decimals are enough and nothing changes.
  assert.equal(offerPriceLabel(20, 'USD'), formatFiatFromPkn(20, 'USD'));
  assert.equal(offerPriceLabel(101, 'DKK'), formatFiatFromPkn(101, 'DKK'));
  // The price field round-trips: what it shows for 1 PKN is read back as 1 PKN, not 2.
  for (const currency of ['USD', 'EUR', 'DKK']) {
    for (const pkn of [1, 2, 3, 7, 19]) {
      assert.equal(offerPricePkn(offerPriceInput(pkn, currency), currency), pkn, `${pkn} PKN in ${currency}`);
    }
  }
  assert.equal(offerPriceInput(1, 'USD'), '0.005');
  assert.equal(offerPriceInput(1, 'PKN'), '1');
});

test('the offer unit is the local currency unless the visitor chose PKN', () => {
  assert.equal(offerUnit('', 'USD'), 'USD');
  assert.equal(offerUnit('PKN', 'USD'), 'PKN');
  assert.equal(offerUnit('pkn', 'dkk'), 'PKN');
  assert.equal(offerUnit('', 'dkk'), 'DKK');
  assert.equal(offerUnit('', ''), 'PKN', 'no currency yet: PKN');
  assert.equal(offerUnit('EUR', 'USD'), 'USD', 'only PKN is a choice; anything else is the local currency');
});
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
    'invalid_buyer_message', 'invalid_cursor', 'invalid_sort', 'not_editable', 'quantity_below_filled', 'buy_order_changed',
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

test('sellableBid: the best offer for one exact facet set, never your own', () => {
  const book = [
    { condition: 'NM', language: 'EN', reverse: false, first_edition: false, best_price_pkn: 2642, best_order_id: 'a', best_remaining: 4 },
    { condition: 'NM', language: 'EN', reverse: true, first_edition: false, best_price_pkn: 3100, best_order_id: 'b', best_remaining: 1 },
    { condition: 'NM', language: 'JP', reverse: false, first_edition: false, best_price_pkn: 900, best_order_id: 'c', best_remaining: 2 },
    { condition: 'SP', language: 'EN', reverse: false, first_edition: false, best_price_pkn: 2100, best_order_id: 'mine', best_remaining: 2 },
  ];
  assert.equal(sellableBid(book, [], { condition: 'NM', language: 'en' }).best_order_id, 'a');
  assert.equal(sellableBid(book, [], { condition: 'NM', language: 'EN', reverse: true }).best_order_id, 'b');
  assert.equal(sellableBid(book, [], { condition: 'NM', language: 'JP' }).best_order_id, 'c');
  // Your own offer is not one to sell into, and a facet nobody wants is null.
  assert.equal(sellableBid(book, ['mine'], { condition: 'SP', language: 'EN' }), null);
  assert.equal(sellableBid(book, [], { condition: 'NM', language: 'EN', firstEdition: true }), null);
  assert.equal(sellableBid(null, [], { condition: 'NM', language: 'EN' }), null);
});


test('fresh book reads bypass the edge cache with a unique parameter', async () => {
  const calls = await captureBodies(async () => {
    await fetchBuyBook('123');
    await fetchBuyBook('123', { fresh: true });
    await fetchBuyBook('123', { fresh: true });
  });
  const urls = calls.map((call) => new URL(call.url, 'https://pokoin.com'));
  assert.equal(urls[0].searchParams.has('fresh'), false);
  assert.ok(urls[1].searchParams.get('fresh'));
  assert.notEqual(urls[1].searchParams.get('fresh'), urls[2].searchParams.get('fresh'));
});
