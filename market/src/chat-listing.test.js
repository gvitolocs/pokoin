import assert from 'node:assert/strict';
import test from 'node:test';
import { appendChatTag, bundleOf, bundleReference, CARD_DRAG_HEIGHT, CARD_DRAG_WIDTH, cardIdOf, cardReference, catalogPath, chatImageSources, isSellerCard, listedCopies, listingReference, looseCardReference, overListingStock, paintOwned, personListsCard, readCardOwned, referenceForPeer, tagKey, writeCardOwned, writeListingDrag } from './chat-listing.js';
import { readFileSync } from 'node:fs';

test('an artist or expansion drag keeps the saved cover and the slug', () => {
  const artist = bundleReference({
    kind: 'artist',
    slug: 'ken-sugimori',
    name: 'Ken Sugimori',
    imageUrl: 'https://cdn.pokoin.com/pikachu.jpg',
    path: '/marketplace/en/artists/ken-sugimori',
  });
  assert.equal(artist.kind, 'artist');
  assert.equal(artist.cardName, 'Ken Sugimori');
  assert.equal(bundleOf(artist).slug, 'ken-sugimori');
  const set = bundleReference({
    kind: 'expansion',
    slug: 'black-bolt',
    name: 'Black Bolt',
    imageUrl: '/card-images/expansions/logos/black-bolt.png',
    path: '/marketplace/sets/black-bolt',
  });
  assert.equal(bundleOf(set).kind, 'expansion');
  assert.equal(set.imageUrl, '/card-images/expansions/logos/black-bolt.png');
  assert.equal(appendChatTag([], set)[0].listingId, 'bundle:expansion:black-bolt');
});

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

test('a listing reference never keeps a CardTrader image URL', () => {
  const row = listingReference({
    offer: {
      id: 'poffin',
      cardImageUrl: 'https://cardtrader.com/uploads/blueprints/image/370822/preview_buddy-buddy-poffin-184-217-ascended-heroes.jpg',
    },
    card: {
      id: '741644',
      name: 'Buddy-Buddy Poffin',
      canonicalPath: '/marketplace/en/cards/741644/card-buddy-buddy-poffin-184-217-ascended-heroes',
    },
  });
  assert.equal(row.imageUrl, '/card-images/370822_buddy-buddy-poffin_homepage.webp');
});

test('chat tags keep one copy of a listing and cap at four', () => {
  const one = { kind: 'listing', listingId: 'a', cardId: '', cardName: 'A', seller: 'red', qty: 3, stock: 8 };
  const kept = appendChatTag([one], one);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].qty, 3);
  assert.equal(kept[0].stock, 8);
  let tags = [];
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    tags = appendChatTag(tags, { kind: 'listing', listingId: id, cardName: id, seller: 'red' });
  }
  assert.deepEqual(tags.map(tagKey), ['listing:b', 'listing:c', 'listing:d', 'listing:e']);
});

test('a miniature keeps a site path and shows the full scan before the homepage thumb', () => {
  const row = looseCardReference({
    name: 'Tympole',
    cardId: '968186',
    href: 'https://pokoin.com/marketplace/en/cards/968186',
    imageUrl: '/card-images/502874_snorlax.jpg',
  });
  assert.equal(row.path, '/marketplace/en/cards/968186');
  assert.equal(catalogPath('/marketplace/en/cards/9?x=1', ''), '/marketplace/en/cards/9');
  assert.deepEqual(chatImageSources({ imageUrl: '/card-images/502874_snorlax.jpg' }), [
    '/card-images/502874_snorlax.jpg',
    '/card-images/502874_snorlax_homepage.webp',
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

test('dragging a Pokémon name keeps every printing of that species', () => {
  const row = bundleReference({
    kind: 'species',
    slug: 'Sandile',
    name: 'Sandile',
    imageUrl: '/card-images/sandile.jpg',
    path: '/marketplace/en/cards/1',
  });
  assert.equal(row.kind, 'species');
  assert.equal(bundleOf(row).slug, 'Sandile');
  assert.equal(overListingStock(3, 2), true);
  assert.equal(overListingStock(2, 2), false);
  assert.equal(overListingStock(3, undefined), false);
  assert.equal(listedCopies([
    { id: 'a', sellerUsername: 'redshakkio', quantityAvailable: 2 },
    { id: 'b', sellerUsername: 'other', quantityAvailable: 9 },
  ], [{ username: 'redshakkio' }]), 2);
});

test('an artist cover drags as a warm pile of one, not a network ghost', () => {
  let dragged = null;
  const { doc, root, kids } = pileDragDocument();
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const warm = {
    nodeType: 1,
    tagName: 'IMG',
    complete: true,
    naturalWidth: 400,
    naturalHeight: 280,
    src: '/card-images/expansions/logos/black-bolt.png',
    currentSrc: '/card-images/expansions/logos/black-bolt.png',
  };
  writeListingDrag({
    clientX: 20,
    clientY: 30,
    currentTarget: warm,
    dataTransfer: {
      setData() {},
      setDragImage(el, x, y) { dragged = { el, x, y }; },
    },
  }, { cardName: 'Ken Sugimori', kind: 'artist', imageUrl: warm.src });
  assert.equal(dragged.el.width, 1);
  assert.equal(dragged.x, 0);
  assert.equal(root.className, 'drag-stack');
  assert.equal(kids.length, 1);
  assert.equal(kids[0].tagName, 'CANVAS');
  // Exact pixel copy of the warm logo (natural size), CSS box is CARD_DRAG_*.
  assert.equal(kids[0].width, 400);
  assert.equal(kids[0].height, 280);
  assert.match(String(kids[0].style?.cssText || ''), /width:240px/);
});

test('card drag imageUrl prefers the homepage derivative already on rails', () => {
  const row = cardReference({
    id: '9',
    name: 'Meowth',
    imageUrl: '/card-images/123_meowth.jpg',
  });
  assert.match(row.imageUrl, /_homepage\.webp$/);
});

test('card drag rewrites CardTrader preview_ to leftover homepage (Eevee desk)', () => {
  const row = cardReference({
    id: '813554',
    name: 'Eevee',
    set: '30th Celebration',
    imageUrl: 'https://cardtrader.com/uploads/blueprints/image/406777/preview_406777-eevee-116-128-30th-celebration.webp',
    canonicalPath: '/marketplace/en/cards/813554/card-eevee-116-128-30th-celebration',
  });
  assert.match(row.imageUrl, /\/card-images\/406777_eevee_homepage\.webp/);
  assert.doesNotMatch(row.imageUrl, /cardtrader/i);
});

function pileDragDocument() {
  const kids = [];
  const root = {
    className: '',
    children: kids,
    setAttribute() {},
    appendChild(node) { kids.push(node); },
    remove() {},
  };
  const doc = {
    createElement: (tag) => {
      if (tag === 'canvas') {
        const blank = {
          tagName: 'CANVAS',
          width: 1,
          height: 1,
          isConnected: false,
          style: {},
          setAttribute() {},
          getContext: () => ({
            fillStyle: '',
            fillRect() {},
            drawImage() {},
          }),
        };
        blank.ownerDocument = doc;
        return blank;
      }
      if (tag === 'div') return root;
      if (tag === 'img') return { tagName: 'IMG', style: {}, alt: '', draggable: false, src: '' };
      return { style: {} };
    },
    body: {
      appendChild(node) {
        if (node) node.isConnected = true;
      },
    },
    images: [],
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, root, kids };
}

test('dragging a shop row uses a pile ghost, including a single card', () => {
  let dragged = null;
  const { doc, root, kids } = pileDragDocument();
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  writeListingDrag({
    clientX: 40,
    clientY: 60,
    currentTarget: {
      nodeType: 1,
      tagName: 'DIV',
      querySelector: () => null,
    },
    dataTransfer: {
      setData() {},
      setDragImage(el, x, y) { dragged = { el, x, y }; },
    },
  }, { cardName: 'Meowth', imageUrl: '/card.jpg', kind: 'card' });
  assert.equal(dragged.el.width, 1);
  assert.equal(dragged.x, 0);
  assert.equal(dragged.y, 0);
  assert.equal(root.className, 'drag-stack');
  assert.equal(kids.length, 1);
  assert.equal(kids[0].tagName, 'CANVAS');
  assert.equal(kids[0].width, CARD_DRAG_WIDTH);
  assert.match(String(kids[0].style?.cssText || ''), /position:fixed/);
});

test('drag pile canvas copies homepage pixels 1:1 (no DPR resample)', () => {
  const { doc, root, kids } = pileDragDocument();
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 2 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  writeListingDrag({
    clientX: 40,
    clientY: 60,
    currentTarget: {
      nodeType: 1,
      tagName: 'DIV',
      querySelector: () => ({
        complete: true,
        naturalWidth: 240,
        naturalHeight: 335,
        src: '/card-images/1_x_homepage.webp',
        currentSrc: '/card-images/1_x_homepage.webp',
      }),
    },
    dataTransfer: { setData() {}, setDragImage() {} },
  }, {
    kind: 'card',
    cardName: 'Meowth',
    imageUrl: '/card-images/1_x_homepage.webp',
  });
  assert.equal(root.className, 'drag-stack');
  assert.equal(kids[0].tagName, 'CANVAS');
  // Backing store matches the warm homepage natural size — not CARD*dpr.
  assert.equal(kids[0].width, 240);
  assert.equal(kids[0].height, 335);
  assert.match(String(kids[0].style?.cssText || ''), /width:240px/);
  assert.match(String(kids[0].style?.cssText || ''), /height:335px/);
});

test('multi-select pile paints each card from its warm tile by data-card-id', () => {
  const { doc, root, kids } = pileDragDocument();
  const warmA = {
    complete: true,
    naturalWidth: 240,
    naturalHeight: 335,
    src: '/card-images/100_a_homepage.webp',
    currentSrc: '/card-images/100_a_homepage.webp',
    classList: { contains: () => false },
  };
  const warmB = {
    complete: true,
    naturalWidth: 240,
    naturalHeight: 335,
    src: '/card-images/200_b_homepage.webp',
    currentSrc: '/card-images/200_b_homepage.webp',
    classList: { contains: () => false },
  };
  const tiles = {
    a: { querySelector: () => warmA },
    b: { querySelector: () => warmB },
  };
  doc.querySelector = (sel) => {
    const match = String(sel).match(/data-card-id="(\d+)"/);
    return match ? tiles[match[1] === '10' ? 'a' : match[1] === '20' ? 'b' : ''] || null : null;
  };
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.CSS = { escape: (value) => String(value) };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  writeListingDrag({
    clientX: 40,
    clientY: 60,
    currentTarget: {
      nodeType: 1,
      tagName: 'A',
      querySelector: () => warmA,
    },
    dataTransfer: { setData() {}, setDragImage() {} },
  }, {
    kind: 'cards',
    cardName: '2 cards',
    imageUrl: warmA.src,
    cards: [
      { cardName: 'A', cardId: '10', imageUrl: '/card-images/100_a.jpg' },
      { cardName: 'B', cardId: '20', imageUrl: '/card-images/200_b.jpg' },
    ],
  });
  assert.equal(kids.length, 2);
  assert.equal(kids[0].width, 240);
  assert.equal(kids[1].width, 240);
  assert.equal(kids[1].height, 335);
});

test('a multi-select pile mounts lagged canvas layers', () => {
  const { doc, root, kids } = pileDragDocument();
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  writeListingDrag({
    clientX: 40,
    clientY: 60,
    currentTarget: { nodeType: 1, tagName: 'DIV', querySelector: () => null },
    dataTransfer: { setData() {}, setDragImage() {} },
  }, {
    kind: 'cards',
    cardName: '3 cards',
    imageUrl: '/a.jpg',
    cards: [
      { cardName: 'A', imageUrl: '/a.jpg' },
      { cardName: 'B', imageUrl: '/b.jpg' },
      { cardName: 'C', imageUrl: '/c.jpg' },
    ],
  });
  assert.equal(root.className, 'drag-stack');
  assert.equal(kids.length, 3);
  assert.ok(kids.every((node) => node.tagName === 'CANVAS'));
  assert.match(String(kids[1].style?.cssText || ''), /position:fixed/);
});

test('dragging the desk frame uses a pile of the held card', () => {
  let dragged = null;
  const { doc, root, kids } = pileDragDocument();
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  writeListingDrag({
    clientX: 12,
    clientY: 18,
    currentTarget: {
      nodeType: 1,
      tagName: 'BUTTON',
      matches: (sel) => sel === '.art-frame',
      querySelector: () => null,
    },
    dataTransfer: {
      setData() {},
      setDragImage(el, x, y) { dragged = { el, x, y }; },
    },
  }, { cardName: 'Meowth', imageUrl: '/desk.jpg', kind: 'card' });
  assert.equal(dragged.el.width, 1);
  assert.equal(root.className, 'drag-stack');
  assert.equal(kids.length, 1);
  assert.equal(kids[0].tagName, 'CANVAS');
});

test('the large desk scan owns the drag gesture instead of its button wrapper', () => {
  const page = readFileSync(new URL('./pages/Card.jsx', import.meta.url), 'utf8');
  const classAt = page.indexOf('className="art-frame"');
  const openAt = page.lastIndexOf('<button', classAt);
  const closeAt = page.indexOf('</button>', classAt);
  const frame = page.slice(openAt, closeAt + '</button>'.length);
  assert.match(page, /import \{ getChatDock \} from '\.\.\/chat-dock-store\.js'/);
  assert.match(frame, /<CardArt[\s\S]*dragCard=\{dragThisCard\(card, payload\?\.offers \|\| \[\]\)\}/);
  assert.doesNotMatch(frame, /draggable=\{Boolean\(art\)\}/);
  assert.doesNotMatch(frame, /onDragStart=/);
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

test('SetGuideGrid drags the whole set card, not only the wordmark img', () => {
  const src = readFileSync(new URL('./components/SetGuideGrid.jsx', import.meta.url), 'utf8');
  assert.match(src, /className="set-guide-card"[\s\S]*?draggable/);
  assert.match(src, /kind: 'expansion'/);
  assert.match(src, /draggable=\{false\}/);
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
  const tag = readFileSync(new URL('./components/ChatListingTag.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./chat-dock.css', import.meta.url), 'utf8');
  assert.match(tag, /className="chat-qty"/);
  assert.match(tag, /className="chat-qty-badge"/);
  assert.match(css, /\.chat-qty-badge[\s\S]*var\(--yellow/);
  assert.equal(tag.includes('footer={quantity}'), false);
});
