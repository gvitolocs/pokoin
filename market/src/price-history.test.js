import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultQuoteSource, formatQuote, observedQuoteDays, quoteSegments, quoteSeries, quoteSeriesKey } from './price-history.js';

test('CardTrader chart uses lowest ask rather than copied median or sales', () => {
  const view = quoteSeries({ cardtrader: { status: 'ok', days: [
    { day: '2026-10-01', lowestAskPkn: 11128, medianPricePkn: 30000, listedQuantity: 6 },
  ] } }, 'cardtrader');
  assert.equal(view.days[0].value, 11128);
  assert.equal(view.days[0].listedQuantity, 6);
  assert.equal(view.label, 'Cheapest listing');
  assert.equal(view.currency, 'PKN');
});

test('TCGplayer subtypes remain separate and decimal values remain exact', () => {
  const series = [
    { productId: 719552, subtype: 'Holofoil', days: [{ day: '2026-09-30', marketPrice: '59.2700' }] },
    { productId: 719552, subtype: 'Reverse Holofoil', days: [{ day: '2026-09-30', marketPrice: '7.1200' }] },
  ];
  const view = quoteSeries({ tcgplayer: { status: 'ok', series } }, 'tcgplayer', quoteSeriesKey(series[1]));
  assert.equal(view.days[0].value, '7.1200');
  assert.equal(view.currency, 'USD');
});

test('missing or null quotes do not become free cards or filled history', () => {
  const days = observedQuoteDays([
    { day: '2026-10-01', value: '59.27' },
    { day: '2026-09-30', value: null },
    { day: '2026-09-29', value: 0 },
    { day: '2026-09-28', value: '' },
    { day: 'bad-date', value: 8 },
    { day: '2026-09-27', value: '56.00' },
  ]);
  assert.deepEqual(days.map((row) => row.day), ['2026-09-27', '2026-10-01']);
  assert.equal(quoteSegments(days).length, 2);
});

test('consecutive observed dates form a line and a single quote remains one point', () => {
  const days = observedQuoteDays([
    { day: '2026-10-01', value: 11128 }, { day: '2026-09-30', value: 12128 },
    { day: '2026-09-29', value: 13128 },
  ]);
  assert.equal(quoteSegments(days).length, 1);
  assert.equal(quoteSegments([days[0]])[0].length, 1);
});

test('PKN has no grouping separator, and unavailable USD prices stay unavailable', () => {
  assert.equal(formatQuote(11128, 'PKN'), '11128 PKN');
  assert.equal(formatQuote('59.2700', 'USD'), '$59.27');
  assert.equal(formatQuote(null, 'USD'), '—');
});

test('default TCGplayer variant uses actual prices and respects an explicit empty variant', () => {
  const history = { tcgplayer: { series: [
    { productId: 10, subtype: 'Normal', days: [{ day: '2026-09-30', marketPrice: null }] },
    { productId: 10, subtype: 'Holofoil', days: [{ day: '2026-09-30', marketPrice: '59.27' }] },
  ] } };
  assert.equal(quoteSeries(history, 'tcgplayer').seriesKey, '10:Holofoil');
  assert.equal(quoteSeries(history, 'tcgplayer', '10:Normal').days[0].value, null);
  assert.equal(defaultQuoteSource(history), 'tcgplayer');
});

test('unpriced daily rows do not replace available recorded-sales graph', () => {
  assert.equal(defaultQuoteSource({
    cardtrader: { days: [{ day: '2026-09-30', lowestAskPkn: 0 }] },
    tcgplayer: { series: [{ productId: 10, days: [{ day: '2026-09-30', marketPrice: null }] }] },
  }), 'sales');
  assert.equal(defaultQuoteSource(null), 'cardtrader');
});
