'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('./_portfolio_history_core.js');

test('a stored today with a market check is not calculated again', () => {
  assert.equal(core.storedIsFresh([
    { date: '2026-09-25', cardsKnown: true, cardsValuePkn: 20 },
  ], '2026-09-25'), true);
  assert.equal(core.storedIsFresh([
    { date: '2026-09-24', cardsKnown: true, cardsValuePkn: 20 },
  ], '2026-09-25'), false);
  assert.equal(core.storedIsFresh([
    { date: '2026-09-25', cardsKnown: false },
  ], '2026-09-25'), false);
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
  assert.equal(core.storedIsFresh(next, '2026-09-26'), true);
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
