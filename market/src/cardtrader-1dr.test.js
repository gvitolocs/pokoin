import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const nav = fs.readFileSync(new URL('./components/StockNav.jsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('./pages/CardTraderOneDay.jsx', import.meta.url), 'utf8');
const zero = fs.readFileSync(new URL('./pages/CardTraderZero.jsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const sales = fs.readFileSync(new URL('./pages/Sales.jsx', import.meta.url), 'utf8');

test('1-Day Ready has its own tab and Zero stays a separate tab', () => {
  assert.match(nav, /\/mypokoin\/1dr/);
  assert.match(nav, /CardTrader 1-DR/);
  assert.match(nav, /account: '1dr'/);
  assert.match(nav, /account: 'zero'/);
  assert.match(app, /both\('\/mypokoin\/1dr',\s*<CardTraderOneDay \/>\)/);
  assert.match(page, /title="CardTrader 1-DR"/);
  assert.doesNotMatch(page, /title="CardTrader Zero"/);
  assert.doesNotMatch(page, /zero-tick/);
  assert.match(page, /Waiting at CardTrader/);
  assert.match(zero, /Navigate to="\/mypokoin\/1dr"/);
  assert.match(sales, /CardTrader 1-DR/);
});
