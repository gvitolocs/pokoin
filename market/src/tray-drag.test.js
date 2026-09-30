import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptTrayDrop,
  cartItemReference,
  desktopItemReference,
  endTrayDrag,
  messagesTrayId,
  peekTrayDrag,
  resetTrayDrag,
  startTrayDrag,
  TRAY_CART,
  TRAY_DESKTOP,
  TRAY_SOURCE_TYPE,
} from './tray-drag.js';
import { LISTING_DRAG_TYPE } from './chat-listing.js';

function fakeEvent() {
  const store = new Map();
  return {
    dataTransfer: {
      effectAllowed: 'none',
      setData(type, value) {
        store.set(type, value);
      },
      getData(type) {
        return store.get(type) || '';
      },
      types: {
        [Symbol.iterator]: function* () {
          yield* store.keys();
        },
      },
      setDragImage() {},
    },
  };
}

test('messagesTrayId keys drafts per peer', () => {
  assert.equal(messagesTrayId('poko'), 'messages:poko');
  assert.equal(messagesTrayId('seller-1'), 'messages:seller-1');
  assert.equal(messagesTrayId(''), 'messages:poko');
});

test('cartItemReference builds a listing drag payload', () => {
  const ref = cartItemReference({
    id: 'listing-9',
    listingId: 'listing-9',
    cardId: '220962',
    name: "Mom's Kindness",
    image: 'https://cdn.example/card.jpg',
    href: '/marketplace/en/cards/220962',
    pricePkn: 40,
    qty: 2,
    stock: 5,
    sellerUid: 'u1',
    sellerName: 'shop',
    condition: 'NM',
    language: 'EN',
  });
  assert.equal(ref.kind, 'listing');
  assert.equal(ref.cardId, '220962');
  assert.equal(ref.listingId, 'listing-9');
  assert.equal(ref.qty, 2);
  assert.equal(ref.cardName, "Mom's Kindness");
});

test('desktopItemReference builds a card drag payload', () => {
  const ref = desktopItemReference({
    id: '220962',
    name: "Mom's Kindness",
    imageUrl: 'https://cdn.example/card.jpg',
    path: '/marketplace/en/cards/220962',
    setName: 'Arceus',
    qty: 3,
  });
  assert.equal(ref.kind, 'card');
  assert.equal(ref.cardId, '220962');
  assert.equal(ref.qty, 3);
  assert.equal(ref.setName, 'Arceus');
});

test('drag out of cart removes; drop back on cart keeps', () => {
  resetTrayDrag();
  let removed = 0;
  const event = fakeEvent();
  const ok = startTrayDrag(event, {
    tray: TRAY_CART,
    reference: cartItemReference({
      id: 'listing-1',
      listingId: 'listing-1',
      cardId: '1',
      name: 'Card',
      pricePkn: 10,
      qty: 1,
    }),
    remove: () => {
      removed += 1;
    },
  });
  assert.equal(ok, true);
  assert.equal(event.dataTransfer.getData(TRAY_SOURCE_TYPE), TRAY_CART);
  assert.ok(event.dataTransfer.getData(LISTING_DRAG_TYPE));
  assert.equal(peekTrayDrag()?.tray, TRAY_CART);

  // Dropped outside → remove
  assert.equal(endTrayDrag(), true);
  assert.equal(removed, 1);
  assert.equal(peekTrayDrag(), null);

  startTrayDrag(event, {
    tray: TRAY_CART,
    reference: cartItemReference({
      id: 'listing-1',
      listingId: 'listing-1',
      cardId: '1',
      name: 'Card',
      pricePkn: 10,
      qty: 1,
    }),
    remove: () => {
      removed += 1;
    },
  });
  acceptTrayDrop(TRAY_CART);
  assert.equal(endTrayDrag(), false);
  assert.equal(removed, 1);
});

test('move from desktop to messages removes from desktop', () => {
  resetTrayDrag();
  let removed = 0;
  const event = fakeEvent();
  startTrayDrag(event, {
    tray: TRAY_DESKTOP,
    reference: desktopItemReference({ id: '9', name: 'Pikachu' }),
    remove: () => {
      removed += 1;
    },
  });
  acceptTrayDrop(messagesTrayId('poko'));
  assert.equal(endTrayDrag(), true);
  assert.equal(removed, 1);
});

test('move between message threads removes the draft source', () => {
  resetTrayDrag();
  let removed = 0;
  const event = fakeEvent();
  startTrayDrag(event, {
    tray: messagesTrayId('alice'),
    reference: { kind: 'card', cardId: '1', cardName: 'Card' },
    remove: () => {
      removed += 1;
    },
  });
  acceptTrayDrop(messagesTrayId('bob'));
  assert.equal(endTrayDrag(), true);
  assert.equal(removed, 1);
});
