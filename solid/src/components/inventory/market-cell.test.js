import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const board = fs.readFileSync(new URL('./InventoryBoard.jsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../../pages/Inventory.jsx', import.meta.url), 'utf8');

/** The source between two markers, so a rule is checked where it is used. */
function slice(text, from, to) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, from);
  const end = text.indexOf(to, start + from.length);
  assert.notEqual(end, -1, to);
  return text.slice(start, end);
}

const cell = slice(board, 'function MarketCell(props) {', 'function StatTile');

test('the market cell prints both of its figures through the label helpers', () => {
  assert.match(cell, /\{inventoryMarketLabel\(props\.value, props\.currency\)\}/);
  assert.match(cell, /ask \{marketAmountLabel\(props\.value\.askPkn, props\.currency\)\}/);
  // Neither figure spells its unit out here: the helper prints the reader's.
  assert.doesNotMatch(cell, /PKN/);
});

test('every view that shows the market column gives it the row price currency', () => {
  const cells = board.match(/<MarketCell [^>]*\/>/g) || [];
  // Stacks, Titles and Table; the Grid tile shows the price alone.
  assert.equal(cells.length, 3);
  for (const markup of cells) {
    assert.match(markup, /currency=\{props\.priceCurrency\}/, markup);
  }
});

test('the board reads the currency the Price cell of the same row prints in', () => {
  assert.match(page, /const formatPrice = \(pkn\) => formatSellerPrice\(pkn, sellerCurrency\(\)\);/);
  assert.match(page, /formatPrice=\{formatPrice\}\n\s*priceCurrency=\{sellerCurrency\(\)\}/);
});

test('the comp stays PKN where it is read, so sorting and the server are untouched', () => {
  assert.match(board, /const market = \(row\) => inventoryMarketValue\(gamePrices\(prices\(\), row, game\(\)\.id\), row, pricerSource\(\)\);/);
});
