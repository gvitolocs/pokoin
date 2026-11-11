import assert from 'node:assert/strict';
import test from 'node:test';
import { previewBook, previewBoard, previewForMyListings, previewMine } from './buysell-preview-fixture.js';

test('the preview book has three conditions and one best order below the facet total', () => {
  const { book } = previewBook('en');
  assert.deepEqual(book.map((row) => row.condition), ['NM', 'SP', 'MP']);
  assert.equal(book.filter((row) => row.best_order_id).length, 1);
  assert.ok(book[0].best_remaining < book[0].quantity);
});

test('the preview board, offers and matches cover every state with the site image only', () => {
  assert.equal(previewBoard().items.length, 8);
  const [high] = previewBoard('price').items;
  assert.equal(high.price_pkn, Math.max(...previewBoard().items.map((row) => row.price_pkn)));
  const mine = previewMine().items;
  assert.deepEqual(mine.map((row) => row.state), ['open', 'filled', 'expired', 'cancelled']);
  assert.ok(mine[1].fills.length === 1 && mine[1].remaining === 0);
  assert.equal(previewForMyListings().items.length, 2);
  for (const row of [...previewBoard().items, ...mine]) assert.equal(row.card_image_url, '/home/missing-card.webp');
});
