'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./_portfolio_history_core.js');

test('a stored today with the sold-day basis is not calculated again', () => {
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-sold-day',
    seriesRevision: 3,
    updatedAt: '2026-09-25T12:00:00.000Z',
  }, '2026-09-25'), true);
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-dump-min',
    seriesRevision: 2,
    updatedAt: '2026-09-25T12:00:00.000Z',
  }, '2026-09-25'), false);
  assert.equal(core.storedIsFresh({
    priceBasis: 'ct-sold-day',
    seriesRevision: 3,
    updatedAt: '2026-09-24T12:00:00.000Z',
  }, '2026-09-25'), false);
  assert.equal(core.storedIsFresh({
    updatedAt: '2026-09-25T20:33:25.586Z',
    days: [{ date: '2026-09-25', cardsKnown: true, cardsValuePkn: 4026552 }],
  }, '2026-09-25'), false);
});

test('sold prices stay on the day of the sale and do not carry forward', () => {
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
  assert.equal(series.find((row) => row.date === '2026-09-22').priceBasis, 'ct-sold-day');
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
  assert.equal(synced.priceBasis, 'ct-sold-day');
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
