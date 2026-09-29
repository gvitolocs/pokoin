'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./_portfolio_history_core.js');

test('a stored today with the last-sold basis is not calculated again', () => {
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-last-sold',
    seriesRevision: 4,
    updatedAt: '2026-09-25T12:00:00.000Z',
  }, '2026-09-25'), true);
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-sold-day',
    seriesRevision: 3,
    updatedAt: '2026-09-25T12:00:00.000Z',
  }, '2026-09-25'), false);
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-dump-min',
    seriesRevision: 2,
    updatedAt: '2026-09-25T12:00:00.000Z',
  }, '2026-09-25'), false);
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-last-sold',
    seriesRevision: 4,
    updatedAt: '2026-09-24T12:00:00.000Z',
  }, '2026-09-25'), false);
  assert.equal(core.storedIsFresh({
    updatedAt: '2026-09-25T20:33:25.586Z',
    days: [{ date: '2026-09-25', cardsKnown: true, cardsValuePkn: 4026552 }],
  }, '2026-09-25'), false);
});

test('applySoldDayValues only prices the days it is given', () => {
  const wallet = core.buildSeries({
    movements: [
      { type: 'account_transfer_received', amountPkn: 15, createdAt: '2026-05-21T12:00:00.000Z' },
    ],
    balance: 15,
    marketChecked: false,
    today: '2026-09-26T18:00:00.000Z',
  });
  const series = core.applySoldDayValues(wallet, [
    { day: '2026-09-22', market_pkn: 900 },
    { day: '2026-09-25', market_pkn: 1100 },
  ], {
    ownershipDate: '2026-09-01T08:00:00.000Z',
    today: '2026-09-26T18:00:00.000Z',
  });
  const may = series.find((row) => row.date === '2026-05-21');
  assert.equal(may.cardsKnown, false);
  assert.equal(may.totalPkn, 15);
  assert.equal(series.find((row) => row.date === '2026-09-22').cardsValuePkn, 900);
  assert.equal(series.find((row) => row.date === '2026-09-22').priceBasis, 'ct-last-sold');
  assert.equal(series.find((row) => row.date === '2026-09-23'), undefined);
  const sold = series.find((row) => row.date === '2026-09-25');
  assert.equal(sold.cardsValuePkn, 1100);
  assert.equal(sold.totalPkn, 1115);
  const today = series.find((row) => row.date === '2026-09-26');
  assert.equal(today.cardsKnown, false);
  assert.equal(today.cardsValuePkn, null);
  assert.equal(today.totalPkn, 15);
});

test('dump minimums start on the sync day and step when the dump changes', () => {
  const wallet = core.buildSeries({
    movements: [
      { type: 'account_transfer_received', amountPkn: 15, createdAt: '2026-05-21T12:00:00.000Z' },
    ],
    balance: 15,
    marketChecked: false,
    today: '2026-09-25T18:00:00.000Z',
  });
  const series = core.applyDumpValues(wallet, [
    { day: '2026-09-20', market_pkn: 1000 },
    { day: '2026-09-22', market_pkn: 900 },
    { day: '2026-09-25', market_pkn: 1100 },
  ], {
    ownershipDate: '2026-09-01T08:00:00.000Z',
    today: '2026-09-25T18:00:00.000Z',
  });
  const may = series.find((row) => row.date === '2026-05-21');
  assert.equal(may.cardsKnown, false);
  assert.equal(may.totalPkn, 15);
  const synced = series.find((row) => row.date === '2026-09-01');
  assert.equal(synced.cardsValuePkn, 1000);
  assert.equal(synced.priceBasis, 'ct-last-sold');
  assert.equal(series.find((row) => row.date === '2026-09-22').cardsValuePkn, 900);
  const today = series.find((row) => row.date === '2026-09-25');
  assert.equal(today.cardsValuePkn, 1100);
  assert.equal(today.currencyPkn, 15);
  assert.equal(today.totalPkn, 1115);
});

test('a dump already in force on the sync day is not replaced by the next print', () => {
  const wallet = core.buildSeries({
    movements: [
      { type: 'account_transfer_received', amountPkn: 15, createdAt: '2026-05-21T12:00:00.000Z' },
    ],
    balance: 15,
    marketChecked: false,
    today: '2026-09-26T08:00:00.000Z',
  });
  const series = core.applyDumpValues(wallet, [
    { day: '2026-08-31', market_pkn: 2760, priced: 2 },
    { day: '2026-09-19', market_pkn: 4073702, priced: 164 },
    { day: '2026-09-23', market_pkn: 4026552, priced: 164 },
    { day: '2026-09-25', market_pkn: 4026530, priced: 164 },
  ], {
    ownershipDate: '2026-09-21T17:52:48.000Z',
    today: '2026-09-26T08:00:00.000Z',
  });
  assert.equal(series.some((row) => row.date === '2026-08-31'), false);
  const synced = series.find((row) => row.date === '2026-09-21');
  assert.equal(synced.cardsValuePkn, 4073702);
  assert.equal(series.find((row) => row.date === '2026-09-23').cardsValuePkn, 4026552);
  assert.equal(series.find((row) => row.date === '2026-09-25').cardsValuePkn, 4026530);
  assert.equal(series.find((row) => row.date === '2026-09-26').cardsValuePkn, 4026530);
  assert.equal(series.find((row) => row.date === '2026-05-21').cardsKnown, false);
});

test('the first series keeps the wallet day and prices cards only on today', () => {
  const series = core.buildSeries({
    movements: [
      { type: 'account_transfer_received', amountPkn: 15, createdAt: '2026-09-01T12:00:00.000Z' },
      { type: 'account_transfer_sent', amountPkn: 5, createdAt: '2026-09-10T12:00:00.000Z' },
    ],
    balance: 10,
    marketCardsPkn: 20,
    marketChecked: true,
    today: '2026-09-25T18:00:00.000Z',
  });
  assert.equal(series[0].date, '2026-08-31');
  assert.equal(series[0].totalPkn, 0);
  assert.equal(series[0].cardsKnown, false);
  assert.equal(series.find((row) => row.date === '2026-09-01').totalPkn, 15);
  const today = series.find((row) => row.date === '2026-09-25');
  assert.equal(today.currencyPkn, 10);
  assert.equal(today.cardsValuePkn, 20);
  assert.equal(today.cardsKnown, true);
  assert.equal(today.totalPkn, 30);
});

test('a later day is appended and the earlier market value stays', () => {
  const stored = core.buildSeries({
    movements: [{ type: 'account_transfer_received', amountPkn: 15, createdAt: '2026-09-01T12:00:00.000Z' }],
    balance: 15,
    marketCardsPkn: 100,
    marketChecked: true,
    today: '2026-09-25T12:00:00.000Z',
  });
  const next = core.upsertDay(stored, {
    date: '2026-09-26',
    currencyPkn: 15,
    cardsValuePkn: 80,
    cardsKnown: true,
  });
  assert.equal(next.find((row) => row.date === '2026-09-25').cardsValuePkn, 100);
  assert.equal(next.find((row) => row.date === '2026-09-26').cardsValuePkn, 80);
  assert.equal(core.storedIsFresh({
    priceBasis: core.PRICE_BASIS,
    seriesRevision: core.SERIES_REVISION,
    updatedAt: '2026-09-26T01:00:00.000Z',
  }, '2026-09-26'), true);
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
    { day: '2026-09-18', blueprint_id: '111585', median_pkn: 40, sold_qty: 1 },
    { day: '2026-09-18', blueprint_id: '111585', median_pkn: 190, sold_qty: 1, reverse: true },
    { day: '2026-09-22', blueprint_id: '111585', median_pkn: 22, sold_qty: 2 },
    { day: '2026-09-22', blueprint_id: '111585', median_pkn: 3243020, sold_qty: 1, reverse: true },
    { day: '2026-09-23', blueprint_id: '111585', median_pkn: 194, sold_qty: 1, reverse: true },
    { day: '2026-09-23', blueprint_id: '111585', median_pkn: 86, sold_qty: 10 },
    { day: '2026-09-23', blueprint_id: '117179', median_pkn: 1162, sold_qty: 1, reverse: true },
    { day: '2026-09-23', blueprint_id: '117179', median_pkn: 131, sold_qty: 22 },
    { day: '2026-09-25', blueprint_id: '117179', median_pkn: 22, sold_qty: 2 },
  ];
  const kept = core.withoutSoldOutliers(rows);
  assert.equal(kept.some((row) => row.price === 3243020), false);
  assert.equal(kept.some((row) => row.price === 1162), true);
  assert.equal(kept.length, 8);
  const at22 = core.lastSoldPrices(rows, '2026-09-22');
  assert.equal(at22('111585', {}), 22);
  assert.equal(at22('111585', { reverse: true }), 190);
  const now = core.lastSoldPrices(rows, '2026-09-29');
  assert.equal(now('111585', { reverse: 't' }), 194);
  assert.equal(now('117179', { reverse: true }), 1162);
  assert.equal(now('117179', {}), 22);
  // A graded copy that never sold falls back to the plain card.
  assert.equal(now('117179', { graded: true }), 22);
  assert.equal(now('999', {}), null);
});

test('card value carries each last sold price forward to today', () => {
  const holdings = new Map([
    [core.variantKey('1', {}), 2],
    [core.variantKey('2', {}), 1],
    [core.variantKey('2', { reverse: true }), 1],
    [core.variantKey('3', {}), 5],
  ]);
  const rows = [
    { day: '2026-09-10', blueprint_id: '1', median_pkn: 100, sold_qty: 1 },
    { day: '2026-09-22', blueprint_id: '2', median_pkn: 50, sold_qty: 1 },
    { day: '2026-09-23', blueprint_id: '2', median_pkn: 400, sold_qty: 1, reverse: true },
    { day: '2026-09-24', blueprint_id: '1', median_pkn: 120, sold_qty: 3 },
    { day: '2026-09-24', blueprint_id: '1', median_pkn: 80, sold_qty: 1 },
    { day: '2026-09-24', blueprint_id: '4', median_pkn: 999, sold_qty: 1 },
  ];
  const days = core.lastSoldCardValues(rows, holdings, { fromDay: '2026-09-21', todayKey: '2026-09-26' });
  assert.deepEqual(days.map((row) => row.day), [
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26',
  ]);
  assert.equal(days[0].market_pkn, 200);
  assert.equal(days[0].priced, 1);
  // Reverse copy of card 2 borrows the plain price until a reverse sells.
  assert.equal(days[1].market_pkn, 300);
  assert.equal(days[1].priced, 3);
  assert.equal(days[2].market_pkn, 650);
  assert.equal(days[3].market_pkn, 670);
  assert.equal(days[5].market_pkn, 670);

  const wallet = core.buildSeries({ movements: [], balance: 15, today: '2026-09-26T18:00:00.000Z' });
  const series = core.applySoldDayValues(wallet, days, {
    ownershipDate: '2026-09-21T08:00:00.000Z',
    today: '2026-09-26T18:00:00.000Z',
  });
  const today = series.find((row) => row.date === '2026-09-26');
  assert.equal(today.cardsKnown, true);
  assert.equal(today.totalPkn, 685);
  assert.deepEqual(core.lastSoldCardValues([], holdings, { fromDay: '2026-09-21', todayKey: '2026-09-26' }), []);
});
