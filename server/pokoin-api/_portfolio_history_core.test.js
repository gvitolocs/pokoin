'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./_portfolio_history_core.js');

const TODAY = '2026-09-27T10:00:00.000Z';

function sold(blueprint, day, condition, language, median, extra = {}) {
  return {
    blueprint_id: String(blueprint),
    day,
    condition,
    language,
    reverse: false,
    first_edition: false,
    graded: false,
    median_pkn: median,
    ...extra,
  };
}

function stock(blueprint, condition, language, quantity, since = '2026-09-21 17:52:48+00', extra = {}) {
  return {
    blueprint_id: String(blueprint),
    condition,
    language,
    reverse: false,
    first_edition: false,
    graded: false,
    quantity,
    since,
    ...extra,
  };
}

test('1-DR LP / HP / PO stock meets the sold table SP / PL / Poor slices', () => {
  assert.equal(core.soldSliceKey(stock(10, 'LP', 'IT', 1)), core.soldSliceKey(sold(10, '2026-09-01', 'SP', 'IT', 5)));
  assert.equal(core.soldSliceKey(stock(10, 'HP', 'IT', 1)), core.soldSliceKey(sold(10, '2026-09-01', 'PL', 'IT', 5)));
  assert.equal(core.soldSliceKey(stock(10, 'PO', 'JP', 1)), core.soldSliceKey(sold(10, '2026-09-01', 'Poor', 'JP', 5)));
  assert.notEqual(core.soldSliceKey(stock(10, 'MP', 'IT', 1)), core.soldSliceKey(sold(10, '2026-09-01', 'MP', 'EN', 5)));
  assert.notEqual(
    core.soldSliceKey(stock(10, 'NM', 'IT', 1, undefined, { reverse: true })),
    core.soldSliceKey(sold(10, '2026-09-01', 'NM', 'IT', 5)),
  );
  assert.equal(core.soldSliceKey({ blueprint_id: 'ct-abc', condition: 'NM' }), '');
});

test('a slice keeps its last sold median until it sells again', () => {
  const book = core.soldPriceBook([
    sold(10, '2026-09-23', 'NM', 'EN', 300),
    sold(10, '2026-09-05', 'NM', 'EN', 200),
    sold(10, '2026-09-10', 'NM', 'EN', 0),
  ]);
  const entries = book.get(core.soldSliceKey(sold(10, '', 'NM', 'EN', 1)));
  assert.equal(entries.length, 2);
  assert.equal(core.priceAsOf(entries, '2026-09-04'), null);
  assert.equal(core.priceAsOf(entries, '2026-09-05').pkn, 200);
  assert.equal(core.priceAsOf(entries, '2026-09-22').pkn, 200);
  assert.equal(core.priceAsOf(entries, '2026-09-27').pkn, 300);
  assert.deepEqual(core.lastSoldFor(stock(10, 'NM', 'EN', 1), book, '2026-09-24'), { pkn: 300, day: '2026-09-23' });
});

test('quiet days carry the pile, other slices never price a card, and a never-sold card adds 0', () => {
  // The seller in the dashboard screenshot: sales printed on 21, 22, 23 and 26
  // September; nothing on 24, 25 or so far today. The old chart dropped to the
  // wallet on every quiet day.
  const holdings = core.holdingSlices([
    stock(118858, 'HP', 'IT', 1), // Potion: only an MP English sale exists
    stock(139076, 'MP', 'JP', 1), // Darkness Energy: only a 2,000,328 PKN PL print exists
    stock(137964, 'MP', 'JP', 2), // Energy Retrieval 275928: never sold
    stock(243540, 'NM', 'IT', 1),
    stock(111585, 'PO', 'IT', 8),
  ]);
  const book = core.soldPriceBook([
    sold(118858, '2026-09-23', 'MP', 'EN', 2300),
    sold(139076, '2026-09-08', 'PL', 'JP', 2000328),
    sold(243540, '2026-09-10', 'NM', 'IT', 4480),
    sold(243540, '2026-09-26', 'NM', 'IT', 4400),
    sold(111585, '2026-09-21', 'Poor', 'IT', 10),
    sold(111585, '2026-09-23', 'Poor', 'IT', 12),
  ]);
  const days = core.buildDailySeries({
    wallet: [{ date: '2026-05-20', currencyPkn: 0 }, { date: '2026-05-21', currencyPkn: 15 }, { date: '2026-09-27', currencyPkn: 15 }],
    holdings,
    book,
    today: TODAY,
  });
  const on = (date) => days.find((row) => row.date === date);
  assert.equal(days[0].date, '2026-05-20');
  assert.equal(days[days.length - 1].date, '2026-09-27');
  // One point per day, no gaps.
  for (let i = 1; i < days.length; i += 1) {
    assert.equal(days[i].date, core.addUtcDays(days[i - 1].date, 1));
  }
  assert.equal(on('2026-09-20').cardsValuePkn, null);
  assert.equal(on('2026-09-20').totalPkn, 15);
  assert.deepEqual(
    [on('2026-09-21').cardsValuePkn, on('2026-09-21').cardsPriced, on('2026-09-21').cardsHeld],
    [4480 + 80, 9, 13],
  );
  assert.equal(on('2026-09-23').cardsValuePkn, 4480 + 96);
  assert.equal(on('2026-09-24').cardsValuePkn, 4480 + 96);
  assert.equal(on('2026-09-25').cardsValuePkn, 4480 + 96);
  assert.equal(on('2026-09-26').cardsValuePkn, 4400 + 96);
  const today = on('2026-09-27');
  assert.equal(today.cardsValuePkn, 4400 + 96);
  assert.equal(today.totalPkn, 15 + 4400 + 96);
  assert.equal(today.cardsPriced, 9);
  assert.equal(today.cardsHeld, 13);
});

test('stock counts from the day it was first synced', () => {
  const holdings = core.holdingSlices([
    stock(1, 'NM', 'EN', 1, '2026-09-21T08:00:00Z'),
    stock(2, 'NM', 'EN', 2, '2026-09-25T08:00:00Z'),
  ]);
  const book = core.soldPriceBook([
    sold(1, '2026-09-01', 'NM', 'EN', 100),
    sold(2, '2026-09-01', 'NM', 'EN', 50),
  ]);
  const days = core.buildDailySeries({ holdings, book, today: TODAY });
  assert.equal(days[0].date, '2026-09-21');
  assert.equal(days.find((row) => row.date === '2026-09-24').cardsValuePkn, 100);
  assert.equal(days.find((row) => row.date === '2026-09-25').cardsValuePkn, 200);
  assert.equal(days.find((row) => row.date === '2026-09-25').cardsHeld, 3);
});

test('a stored day keeps the cards it had, so a card sold since does not vanish from the past', () => {
  const book = core.soldPriceBook([sold(1, '2026-09-01', 'NM', 'EN', 100), sold(2, '2026-09-01', 'NM', 'EN', 900)]);
  const before = core.buildDailySeries({
    holdings: core.holdingSlices([stock(1, 'NM', 'EN', 1), stock(2, 'NM', 'EN', 1)]),
    book,
    today: '2026-09-24T12:00:00.000Z',
  });
  const doc = {
    days: before,
    priceBasis: core.PRICE_BASIS,
    seriesRevision: core.SERIES_REVISION,
    updatedAt: '2026-09-24T12:00:00.000Z',
  };
  // Blueprint 2 sold on the 25th, so the 1-DR table no longer has it.
  const after = core.buildDailySeries({
    holdings: core.holdingSlices([stock(1, 'NM', 'EN', 1)]),
    book,
    frozen: core.frozenCardDays(doc, '2026-09-27'),
    today: TODAY,
  });
  const on = (date) => after.find((row) => row.date === date);
  assert.equal(on('2026-09-21').cardsValuePkn, 1000);
  assert.equal(on('2026-09-24').cardsValuePkn, 1000);
  assert.equal(on('2026-09-25').cardsValuePkn, 100);
  assert.equal(on('2026-09-27').cardsValuePkn, 100);
  // Today is always re-priced, and an older basis is never frozen.
  assert.equal(core.frozenCardDays(doc, '2026-09-24').has('2026-09-24'), false);
  assert.equal(core.frozenCardDays({ ...doc, seriesRevision: 3 }, '2026-09-27').size, 0);
  assert.equal(core.frozenCardDays({ ...doc, priceBasis: 'ct-sold-day' }, '2026-09-27').size, 0);
});

test('a day stored without cards is re-priced once holdings reach back to it', () => {
  const book = core.soldPriceBook([sold(1, '2026-09-01', 'NM', 'EN', 100)]);
  // Stored while the stock looked brand new: 21-26 Sep have no card value.
  const doc = {
    days: ['2026-09-21', '2026-09-22', '2026-09-26'].map((date) => ({ date, currencyPkn: 15 })),
    priceBasis: core.PRICE_BASIS,
    seriesRevision: core.SERIES_REVISION,
  };
  const frozen = core.frozenCardDays(doc, '2026-09-27');
  assert.equal(frozen.size, 0);
  const days = core.buildDailySeries({
    holdings: core.holdingSlices([{ ...stock(1, 'NM', 'EN', 2), since: '2026-09-21 17:52:48+00' }]),
    book,
    frozen,
    today: TODAY,
  });
  assert.equal(days.find((row) => row.date === '2026-09-22').cardsValuePkn, 200);
});

test('the series keeps at most 400 days and starts empty without wallet or stock', () => {
  assert.deepEqual(core.buildDailySeries({ today: TODAY }), []);
  const days = core.buildDailySeries({
    wallet: [{ date: '2024-01-01', currencyPkn: 15 }],
    today: TODAY,
  });
  assert.equal(days.length, core.HISTORY_DAYS);
  assert.equal(days[0].totalPkn, 15);
  assert.equal(days[days.length - 1].date, '2026-09-27');
});

test('a stored series is reused for fifteen minutes of the same UTC day', () => {
  const doc = {
    priceBasis: core.PRICE_BASIS,
    seriesRevision: core.SERIES_REVISION,
    updatedAt: '2026-09-27T10:00:00.000Z',
  };
  assert.equal(core.storedIsFresh(doc, new Date('2026-09-27T10:14:00.000Z')), true);
  assert.equal(core.storedIsFresh(doc, new Date('2026-09-27T10:16:00.000Z')), false);
  assert.equal(core.storedIsFresh({ ...doc, updatedAt: '2026-09-26T23:59:00.000Z' }, new Date('2026-09-27T00:01:00.000Z')), false);
  assert.equal(core.storedIsFresh({ ...doc, seriesRevision: 3 }, new Date('2026-09-27T10:01:00.000Z')), false);
  assert.equal(core.storedIsFresh({ ...doc, priceBasis: 'ct-sold-day' }, new Date('2026-09-27T10:01:00.000Z')), false);
});

test('the wallet starts at zero the day before its first movement and ends on the live balance', () => {
  const wallet = core.walletSeries({
    movements: [
      { type: 'account_transfer_received', amountPkn: 15, createdAt: '2026-09-01T12:00:00.000Z' },
      { type: 'account_transfer_sent', amountPkn: 5, createdAt: '2026-09-10T12:00:00.000Z' },
    ],
    balance: 10,
    today: '2026-09-25T18:00:00.000Z',
  });
  assert.deepEqual(wallet, [
    { date: '2026-08-31', currencyPkn: 0 },
    { date: '2026-09-01', currencyPkn: 15 },
    { date: '2026-09-10', currencyPkn: 10 },
    { date: '2026-09-25', currencyPkn: 10 },
  ]);
  const days = core.buildDailySeries({ wallet, today: '2026-09-25T18:00:00.000Z' });
  assert.equal(days.find((row) => row.date === '2026-09-05').currencyPkn, 15);
  assert.equal(days.find((row) => row.date === '2026-09-05').cardsKnown, false);
  assert.deepEqual(core.walletSeries({ balance: 0, today: TODAY }), []);
  assert.deepEqual(core.walletSeries({ balance: 15, today: TODAY }), [{ date: '2026-09-27', currencyPkn: 15 }]);
});

test('firestore timestamps become a ledger day', () => {
  const row = core.movementFromLedger({
    type: 'account_transfer_received',
    amountPkn: 15,
    createdAt: { seconds: Date.parse('2026-09-01T00:00:00.000Z') / 1000 },
  });
  assert.equal(row.date, '2026-09-01');
  assert.equal(row.amountPkn, 15);
});

test('a withdrawn joke listing is not a sold price; reverse copies are their own market', () => {
  const rows = [
    { day: '2026-09-18', blueprint_id: '111585', condition: 'NM', language: 'EN', median_pkn: 40 },
    { day: '2026-09-18', blueprint_id: '111585', condition: 'NM', language: 'EN', median_pkn: 190, reverse: true },
    { day: '2026-09-22', blueprint_id: '111585', condition: 'NM', language: 'EN', median_pkn: 22 },
    { day: '2026-09-22', blueprint_id: '111585', condition: 'NM', language: 'EN', median_pkn: 3243020, reverse: true },
    { day: '2026-09-23', blueprint_id: '111585', condition: 'MP', language: 'IT', median_pkn: 194, reverse: true },
    { day: '2026-09-23', blueprint_id: '117179', condition: 'NM', language: 'EN', median_pkn: 1162, reverse: true },
    { day: '2026-09-23', blueprint_id: '117179', condition: 'NM', language: 'EN', median_pkn: 131 },
  ];
  const kept = core.withoutSoldOutliers(rows).map((row) => row.median_pkn);
  assert.equal(kept.includes(3243020), false);
  assert.equal(kept.includes(1162), true);
  assert.equal(kept.length, 6);
  const book = core.soldPriceBook(rows);
  const reverse = stock(111585, 'NM', 'EN', 1, undefined, { reverse: true });
  // The joke print is gone, so the reverse copy keeps its real 190 PKN sale.
  assert.deepEqual(core.lastSoldFor(reverse, book, '2026-09-27'), { pkn: 190, day: '2026-09-18' });
});
