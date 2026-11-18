import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('spreadsheet page and sell tile are wired', () => {
  const view = read('../components/dashboard/SellerDashboardView.jsx');
  const page = read('./SellSpreadsheet.jsx');
  const nav = read('../components/StockNav.jsx');
  const profile = read('./Profile.jsx');
  assert.match(view, /Sell and Buy/);
  assert.match(view, /SellSpreadsheetTile/);
  assert.match(page, /Drag your file here or click to browse files/);
  assert.match(page, /Copy and paste a text/);
  assert.match(page, /Recent imports/);
  assert.match(page, /if \(!import\.meta\.env\.DEV\) return false/);
  assert.match(page, /IMPORT_COLUMNS/);
  assert.match(nav, /\/mypokoin\/spreadsheet/);
  assert.match(profile, /Sell via spreadsheet/);
});
