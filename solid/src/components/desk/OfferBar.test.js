import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const bar = readFileSync(new URL('./OfferBar.jsx', import.meta.url), 'utf8');
const book = readFileSync(new URL('../../lib/buy-book.js', import.meta.url), 'utf8');

test('offer price opens edit mode for an owned order and saves it', () => {
  assert.match(bar, /<button type="button" class="offer-bar-price"[^>]*onClick=\{editPrice\}/);
  assert.match(bar, /buy\.mine\(\)\.includes\(id\)/);
  assert.match(bar, /setEditing\(order\)/);
  assert.match(bar, /updateBuyOrder\(editing\(\)\.id, \{ price_pkn: pkn, quantity \}, token\)/);
  assert.match(bar, /Save offer/);
});

test('cancel removes single-order rows and reloads fresh', () => {
  assert.match(book, /dropOrderRow\(id\);\s*await load\(String\(cardId\), \{ fresh: true \}\)/);
  assert.match(book, /Number\(row\.orders\).*=== 1/);
});
