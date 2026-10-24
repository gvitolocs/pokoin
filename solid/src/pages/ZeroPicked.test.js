import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('./ZeroPicked.jsx');
const fixture = read('./mypokoin-preview-fixture.js');
const routes = read('../routes/account.js');
const api = read('../../../market/src/api.js');

test('/mypokoin/picked is a lazy route of its own page', () => {
  assert.match(routes, /const ZeroPicked = lazy\(\(\) => import\('\.\.\/pages\/ZeroPicked\.jsx'\)\);/);
  assert.match(routes, /\{ path: '\/mypokoin\/picked', component: ZeroPicked \}/);
});

test('reads GET /api/cardtrader-zero-picked and shows card, facets, location, shipment, picked at, price', () => {
  assert.match(api, /export function fetchCardTraderZeroPicked\(token\)[\s\S]*?'\/api\/cardtrader-zero-picked'/);
  assert.match(page, /fetchCardTraderZeroPicked\(token\)/);
  for (const head of ['Card', 'Details', 'Came from', 'Zero shipment', 'Picked at', 'Sold for']) {
    assert.match(page, new RegExp(`>${head}<`));
  }
  assert.match(page, /row\.locationFrom/);
  assert.match(page, /row\.orderCode \|\| row\.orderId/);
  assert.match(page, /listingLanguageFlag\(row\.language\)/);
});

test('Undo puts the copy back: action undo, once per row, never in preview', () => {
  assert.match(page, /action: 'undo'/);
  assert.match(page, /'Undo \(back to inventory\)'/);
  assert.match(page, /if \(flight\.has\(key\)\) return;/);
  assert.match(page, /if \(!props\.preview\) \{\s*const token = await getBearer\(\);\s*await saveCardTraderZeroPick\(token, undoBody\(row\)\);/);
});

test('picked copies are not listings: no stock metrics, preview has 4 rows', () => {
  assert.doesNotMatch(page, /fetchInventory|Cards in stock|Live listings/);
  assert.match(page, /not in Listings or your stock totals/);
  assert.match(page, /previewZeroPicked\(\)\.rows/);
  const rows = fixture.slice(fixture.indexOf('const ZERO_PICKED = ['), fixture.indexOf('export function previewZeroPicked'));
  assert.equal((rows.match(/\{ id: \d+,/g) || []).length, 4);
});
