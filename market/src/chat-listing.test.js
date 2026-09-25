import assert from 'node:assert/strict';
import test from 'node:test';
import { appendChatTag, CARD_DRAG_HEIGHT, CARD_DRAG_WIDTH, cardIdOf, cardReference, catalogPath, chatImageSources, isSellerCard, listingReference, looseCardReference, paintOwned, personListsCard, readCardOwned, referenceForPeer, tagKey, writeCardOwned, writeListingDrag } from './chat-listing.js';
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

test('a miniature keeps a site path and tries the homepage thumb before the full scan', () => {
  const row = looseCardReference({
    name: 'Tympole',
    cardId: '968186',
    href: 'https://pokoin.com/marketplace/en/cards/968186',
    imageUrl: '/card-images/502874_snorlax.jpg',
  });
  assert.equal(row.path, '/marketplace/en/cards/968186');
  assert.equal(catalogPath('/marketplace/en/cards/9?x=1', ''), '/marketplace/en/cards/9');
  assert.deepEqual(chatImageSources({ imageUrl: '/card-images/502874_snorlax.jpg' }), [
    '/card-images/502874_snorlax_homepage.webp',
    '/card-images/502874_snorlax.jpg',
  ]);
  assert.equal(row.kind, 'card');
});

test('dragging the scan keeps the open chat person when they list that card', () => {
  const card = { id: '88', name: 'Meowth', canonicalPath: '/marketplace/en/cards/88', heroImageUrl: '/card-images/9_meowth.jpg' };
  const offers = [{
    id: 'lst',
    sellerUsername: 'redshakkio',
    sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    pricePkn: 64,
    cardImageUrl: '/card-images/9_meowth.jpg',
  }];
  const theirs = referenceForPeer(card, offers, { uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2', username: 'redshakkio' });
  assert.equal(theirs.kind, 'listing');
  assert.equal(theirs.seller, 'redshakkio');
  assert.equal(isSellerCard(theirs), true);
  const trade = referenceForPeer(card, offers, { uid: 'someoneelse', username: 'other' });
  assert.equal(trade.kind, 'card');
  assert.equal(isSellerCard(trade), false);
  assert.equal(cardIdOf({ path: '/marketplace/en/cards/88' }), '88');
  assert.equal(personListsCard(offers, [{ username: 'redshakkio' }]), true);
  assert.equal(personListsCard(offers, [{ username: 'other' }]), false);
});

test('a trade card remembers gray, and a refresh can turn it color when the seller lists it', () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  const row = { cardId: '219916', cardName: 'Meowth', imageUrl: '', seller: '', sellerUid: '' };
  const people = [{ uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2', username: 'redshakkio' }];
  assert.equal(paintOwned(row, '219916', people), 'no');
  writeCardOwned('219916', people, 'no');
  assert.equal(readCardOwned('219916', [{ username: 'redshakkio' }]), 'no');
  assert.equal(paintOwned(row, '219916', [{ username: 'redshakkio' }]), 'no');
  writeCardOwned('219916', people, 'yes');
  assert.equal(readCardOwned('219916', [{ uid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2' }]), 'yes');
  assert.equal(paintOwned(row, '219916', people), 'yes');
});

test('dragging a shop row carries a card-sized image, not the whole row', () => {
  let dragged = null;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ({
      setTransform() {},
      clearRect() {},
      save() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillRect() {},
      restore() {},
      roundRect() {},
      drawImage() {},
      getImageData() { return { data: [1, 2, 3, 255] }; },
    }),
  };
  globalThis.document = {
    createElement: () => canvas,
    body: { appendChild() {} },
  };
  writeListingDrag({
    currentTarget: {
      nodeType: 1,
      tagName: 'DIV',
      querySelector: (selector) => (selector.includes('.shop-card img') ? { naturalWidth: 63, naturalHeight: 88 } : null),
    },
    dataTransfer: {
      setData() {},
      setDragImage(el, x, y) { dragged = { el, x, y }; },
    },
  }, { cardName: 'Meowth' });
  assert.equal(dragged.el, canvas);
  assert.equal(canvas.width, CARD_DRAG_WIDTH);
  assert.equal(canvas.height, CARD_DRAG_HEIGHT);
  assert.equal(dragged.x, CARD_DRAG_WIDTH / 2);
  assert.equal(dragged.y, CARD_DRAG_HEIGHT / 2);
});

test('dragging the desk frame uses the scan inside the frame', () => {
  let dragged = null;
  writeListingDrag({
    currentTarget: {
      nodeType: 1,
      tagName: 'BUTTON',
      matches: (sel) => sel === '.art-frame',
      querySelector: (selector) => (
        selector === 'img' ? { naturalWidth: 630, naturalHeight: 880 } : null
      ),
    },
    dataTransfer: {
      setData() {},
      setDragImage(el, x, y) { dragged = { el, x, y }; },
    },
  }, { cardName: 'Meowth' });
  assert.equal(dragged.x, CARD_DRAG_WIDTH / 2);
  assert.equal(dragged.y, CARD_DRAG_HEIGHT / 2);
});

test('a homepage card is not a seller card', () => {
  const listing = listingReference({
    offer: { id: '1', sellerUsername: 'redshakkio', sellerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2' },
    card: { id: '9', name: 'Meowth' },
  });
  const traded = cardReference({ id: '25', name: 'Pikachu' });
  assert.equal(isSellerCard(listing), true);
  assert.equal(isSellerCard(traded), false);
});

test('shop rows show a message icon before the cart icon', () => {
  const src = readFileSync(new URL('./components/ShopListing.jsx', import.meta.url), 'utf8');
  const message = src.indexOf('Message this seller about this listing');
  const cart = src.indexOf('Add to cart');
  assert.ok(message > 0);
  assert.ok(cart > message);
  assert.match(src, /sellerUid/);
  assert.match(src, /className="ct-qty"/);
  assert.match(src, /<ThumbZoom src=\{full\} full alt=\{name \|\| ''\}>/);
  assert.match(src, /className="art-cut shop-art"/);
  assert.match(src, /of \{stock \|\| choices\}/);
});
