import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryMarketLabel, inventoryMarketValue } from './inventory-price.js';

const row = { cardId: '824942' };
const daily = { days: [
  { day: '2026-10-02', lowestAskPkn: 11128, sourceTimestamp: '2026-10-02T02:27:50Z' },
  { day: '2026-09-30', lowestAskPkn: 13128, sourceTimestamp: '2026-09-30T15:57:44Z' },
] };

test('pricer keeps current condition/language match ahead of daily all-facet cheapest ask', () => {
  const value = inventoryMarketValue({ 824942: { ctMatchedPkn: 14000, ctCheapestPkn: 11128, cardtraderListed: daily } }, row, 'cardtrader');
  assert.equal(value.value, 14000);
  assert.match(value.title, /matching condition and language/);
  assert.match(value.title, /2026-10-02: 11128 PKN/);
  assert.match(value.title, /listing asks, not sold prices/);
});

test('daily dump fallback is dated and never presented as a facet-matched quote or sale', () => {
  const value = inventoryMarketValue({ 824942: { cardtraderListed: daily } }, row, 'cardtrader');
  assert.equal(value.value, 11128);
  assert.match(value.title, /Latest stored daily cheapest/);
  assert.match(value.title, /across conditions and languages/);
  assert.equal(inventoryMarketLabel(value), '11128 PKN');
});

test('TCGplayer variants retain USD and source timestamps without PKN conversion', () => {
  const value = inventoryMarketValue({ 824942: { tcgplayer: [
    { marketPrice: '59.2700', subtype: 'Holofoil', sourceTimestamp: '2026-09-30T20:05:12Z' },
    { marketPrice: '70.10', subtype: 'Reverse Holofoil', sourceTimestamp: '2026-09-30T20:05:12Z' },
  ] } }, row, 'tcgplayer');
  assert.equal(value.currency, 'USD');
  assert.equal(inventoryMarketLabel(value), '$59.27–$70.10 USD');
  assert.match(value.title, /Holofoil: \$59.2700/);
  assert.match(value.title, /condition is unspecified/);
});

test('missing, null, zero and invalid TCGplayer quotes stay unavailable', () => {
  assert.equal(inventoryMarketValue({ 824942: { tcgplayer: [
    { marketPrice: null }, { marketPrice: '0' }, { marketPrice: '-1' }, { marketPrice: 'unknown' },
  ] } }, row, 'tcgplayer'), null);
  assert.equal(inventoryMarketValue({}, row, 'cardtrader'), null);
  assert.equal(inventoryMarketLabel(null), '—');
});

test('Pokoin sold fallback is explicitly attributed to CardTrader inferred sales', () => {
  const value = inventoryMarketValue({ 824942: { soldMedianPkn: 20000 } }, row, 'pokoin');
  assert.equal(value.value, 20000);
  assert.match(value.title, /CardTrader 30-day inferred-sale median/);
  assert.equal(inventoryMarketLabel(value), '20000 PKN');
});
