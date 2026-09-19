'use strict';

// Source-shape contract for the pokoin-web-owned search endpoint files.
// These read the exact files that ship to the Pi release overlay and fail
// if a future edit silently breaks the search-universe invariants:
//
//   SEARCH_TABS = { singles, product, users }  (SPA side, market/src)
//   jumbo ⊂ product                             (engine side, server/api)
//   productType=jumbo stays an exact narrow filter
//   totals answer the same WHERE/predicate as the rows

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const apiDir = __dirname;
const cardsSource = fs.readFileSync(path.join(apiDir, 'marketplace-cards.js'), 'utf8');
const searchPageSource = fs.readFileSync(path.join(apiDir, 'marketplace-search-page.js'), 'utf8');
const searchKindSource = fs.readFileSync(
  path.join(apiDir, '..', '..', 'market', 'src', 'search-kind.js'),
  'utf8',
);

test('productSearchOnly is the Product universe: sealed products OR the jumbo subtype', () => {
  const clauseBody = cardsSource.slice(
    cardsSource.indexOf('function productTypeClause'),
    cardsSource.indexOf('function searchClause'),
  );
  assert.match(clauseBody, /Search tabs never split card vs jumbo/);
  assert.match(clauseBody, /" and \(marketplace_search_candidates\.item_kind = 'product'"/);
  assert.match(clauseBody, /\+ " or marketplace_search_candidates\.product_type = 'jumbo'\)"/);
  assert.match(clauseBody, /if \(normalized\)/);
  assert.match(clauseBody, /product_type = \$\$\{values\.length\}/);
});

test('productType=jumbo bypasses the Meili window so the aisle lists every jumbo', () => {
  assert.match(cardsSource, /typedProduct !== 'jumbo'/);
});

test('rowsForCards threads the same-predicate total through both engines', () => {
  // Meili window: the { rows, total } payload rides the candidates load.
  assert.match(cardsSource, /withTotal: withTotal === true/);
  assert.match(cardsSource, /return \{ rows: next, total: Number\.isFinite\(meiliTotal\) \? meiliTotal : null \};/);
  // Legacy SQL path: same-WHERE exact count via a window function evaluated
  // before LIMIT — no second query, no divergent predicate.
  assert.match(cardsSource, /count\(\*\) over \(\) as total_count/);
  assert.match(cardsSource, /return \{ rows, total: Number\.isFinite\(firstRowCount\) \? firstRowCount : null \};/);
});

test('marketplace-search-page exposes total beside count', () => {
  assert.match(searchPageSource, /withTotal: true/);
  assert.match(searchPageSource, /total: queryTotal,/);
});

test('the SPA keeps exactly three top-level search tabs and routes jumbo into Product', () => {
  assert.match(searchKindSource, /id: 'singles'/);
  assert.match(searchKindSource, /id: 'product'/);
  assert.match(searchKindSource, /id: 'users'/);
  assert.doesNotMatch(searchKindSource, /id: 'jumbo'/);
  assert.match(searchKindSource, /if \(id === 'jumbo'\) \{\s*return 'product';/);
});
