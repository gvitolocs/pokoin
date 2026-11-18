import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const nav = read('../components/StockNav.jsx');
const page = read('./CardTraderOneDay.jsx');
const zero = read('./CardTraderZero.jsx');
const sales = read('./Sales.jsx');
// Sale-row labels are shared (market/src/order-rows.js).
const saleRows = read('../../../market/src/order-rows.js');

test('1-Day Ready has its own tab and Zero stays a separate tab', () => {
  assert.match(nav, /\/mypokoin\/1dr/);
  assert.match(nav, /CardTrader 1-DR/);
  assert.match(nav, /account: '1dr'/);
  assert.match(nav, /account: 'zero'/);
  assert.match(page, /title="CardTrader 1-DR"/);
  assert.doesNotMatch(page, /title="CardTrader Zero"/);
  assert.doesNotMatch(page, /zero-tick/);
  assert.match(page, /Waiting at CardTrader/);
  assert.match(page, /View all cards/);
  assert.match(page, /MiniCardTile/);
  assert.match(sales, /class="sale-thumb"/);
  assert.match(zero, /navigate\('\/mypokoin\/1dr', \{ replace: true \}\)/);
  assert.match(saleRows, /CardTrader 1-DR/);
});
