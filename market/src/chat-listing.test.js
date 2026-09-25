import assert from 'node:assert/strict';
import test from 'node:test';
import { appendChatTag, listingReference, tagKey } from './chat-listing.js';
import { readFileSync } from 'node:fs';

test('a listing chat follows the Firebase user id, not the stored email', () => {
  const row = listingReference({
    offer: {
      id: '1',
      sellerUsername: 'redshakkio@gmail.com',
      sellerName: 'redshakkio@gmail.com',
      sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
      cardName: 'Drifloon',
    },
  });
  assert.equal(row.sellerUid, 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2');
  assert.equal(row.seller, '');
});

test('a shop listing reference keeps the seller handle and card name', () => {
  const row = listingReference({
    offer: {
      id: 'lst-1',
      sellerUsername: 'redshakkio',
      sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
      pricePkn: 76,
      cardImageUrl: 'https://cdn.pokoin.com/a.jpg',
    },
    card: { id: '9', name: 'Drifloon', canonicalPath: '/marketplace/en/cards/9' },
  });
  assert.equal(row.kind, 'listing');
  assert.equal(row.sellerUid, 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2');
  assert.equal(row.seller, 'redshakkio');
  assert.equal(row.cardName, 'Drifloon');
  assert.equal(row.pricePkn, 76);
});

test('chat tags keep one copy of a listing and cap at four', () => {
  const one = { kind: 'listing', listingId: 'a', cardId: '', cardName: 'A', seller: 'red' };
  assert.equal(appendChatTag([one], one).length, 1);
  let tags = [];
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    tags = appendChatTag(tags, { kind: 'listing', listingId: id, cardName: id, seller: 'red' });
  }
  assert.deepEqual(tags.map(tagKey), ['listing:b', 'listing:c', 'listing:d', 'listing:e']);
});

test('shop rows show a message icon before the cart icon', () => {
  const src = readFileSync(new URL('./components/ShopListing.jsx', import.meta.url), 'utf8');
  const message = src.indexOf('Message this seller about this listing');
  const cart = src.indexOf('Add to cart');
  assert.ok(message > 0);
  assert.ok(cart > message);
  assert.match(src, /sellerUid/);
});
