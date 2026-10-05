import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  loadSpreadsheetImports,
  nextImportId,
  recordFromImport,
  saveSpreadsheetImports,
} from './spreadsheet-imports.js';

function memory() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test('a dry run is Ready and a real import is Completed', () => {
  const ready = recordFromImport({
    id: 4,
    game: 'Pokémon',
    result: { dryRun: true, counts: { total: 3, preview: 2, failed: 1, created: 0, skipped: 0 } },
  });
  assert.equal(ready.status, 'Ready');
  assert.equal(ready.created, 0);
  assert.equal(ready.errors, 1);
  assert.equal(ready.mode, 'Add');

  const done = recordFromImport({
    id: 4,
    game: 'Magic',
    result: { dryRun: false, counts: { total: 3, preview: 0, failed: 1, created: 2, skipped: 0 } },
  });
  assert.equal(done.status, 'Completed');
  assert.equal(done.created, 2);
  assert.equal(done.game, 'Magic');
});

test('recent imports persist in the provided storage', () => {
  const storage = memory();
  assert.deepEqual(loadSpreadsheetImports(storage), []);
  const rows = [recordFromImport({ id: 1, game: 'Pokémon', result: { counts: { total: 1, created: 1 } } })];
  saveSpreadsheetImports(rows, storage);
  assert.equal(loadSpreadsheetImports(storage)[0].id, 1);
  assert.equal(nextImportId(loadSpreadsheetImports(storage)), 2);
});

test('spreadsheet page and sell tile are wired', () => {
  const app = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('./components/SellerDashboardView.jsx', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('./pages/SellSpreadsheet.jsx', import.meta.url), 'utf8');
  const nav = fs.readFileSync(new URL('./components/StockNav.jsx', import.meta.url), 'utf8');
  const profile = fs.readFileSync(new URL('./pages/Profile.jsx', import.meta.url), 'utf8');
  assert.match(app, /both\('\/mypokoin\/spreadsheet',\s*<SellSpreadsheet \/>\)/);
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
