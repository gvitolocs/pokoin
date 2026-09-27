import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  clearShopSelectionOnPointer,
  listingSelectId,
  marqueeBlocked,
  marqueeRect,
  marqueeStartAllowed,
  mixedDeskDragReference,
  rectsIntersect,
  selectBandAllowed,
  shopDragOffers,
} from './shop-marquee.js';

test('a rubber band starts on the card scan, not on a button', () => {
  const control = { closest: (sel) => (String(sel).includes('button') ? control : null) };
  const scan = { closest: (sel) => (String(sel).includes('.shop-art') ? scan : null) };
  const body = { closest: () => null };
  assert.equal(marqueeBlocked(control), true);
  assert.equal(marqueeBlocked(scan), false);
  assert.equal(marqueeBlocked(body), false);
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const selected = new Set(['a', 'c']);
  assert.deepEqual(shopDragOffers(rows, selected, rows[0]).map((row) => row.id), ['a', 'c']);
  assert.deepEqual(shopDragOffers(rows, selected, rows[2]).map((row) => row.id), ['c', 'a']);
  assert.equal(shopDragOffers(rows, new Set(['a']), rows[0]), null);

  const rect = marqueeRect(10, 30, 4, 8);
  assert.deepEqual(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    { left: 4, top: 8, width: 6, height: 22 },
  );
  assert.equal(rectsIntersect(rect, { left: 0, top: 0, right: 5, bottom: 10 }), true);
  assert.equal(rectsIntersect(rect, { left: 20, top: 0, right: 30, bottom: 10 }), false);
  assert.equal(listingSelectId({ id: 'lst-1' }), 'lst-1');
});

test('empty page background may start a shop marquee; shop rows and art may not', () => {
  function mock(hits) {
    return {
      closest: (sel) => {
        const parts = String(sel).split(',').map((part) => part.trim());
        return parts.some((part) => hits.includes(part)) ? mock(hits) : null;
      },
    };
  }
  const bg = mock(['main']);
  const art = mock(['.art-frame', 'main']);
  const tile = mock(['[data-card-id]', 'main']);
  const shop = mock(['.shop-row']);
  const panel = mock(['.shop-panel', 'main']);
  const species = mock(['.species-drag', 'header', 'main']);
  const setLink = mock(['a', '.asset-sub', 'header', 'main']);
  assert.equal(marqueeStartAllowed(bg), true);
  assert.equal(marqueeStartAllowed(art), false);
  assert.equal(marqueeStartAllowed(tile), false);
  assert.equal(marqueeStartAllowed(shop), false);
  assert.equal(marqueeStartAllowed(panel), false);
  assert.equal(marqueeStartAllowed(species), false);
  assert.equal(marqueeStartAllowed(setLink), false);
});

test('select band stays off on touch, phone widths, and account pages', () => {
  const marketWin = {
    location: { pathname: '/marketplace/en/cards/1' },
    matchMedia: () => ({ matches: false }),
  };
  assert.equal(selectBandAllowed({ pointerType: 'mouse' }, marketWin), true);
  assert.equal(selectBandAllowed({ pointerType: 'touch' }, marketWin), false);
  assert.equal(selectBandAllowed({ pointerType: 'pen' }, marketWin), false);
  assert.equal(
    selectBandAllowed({ pointerType: 'mouse' }, {
      location: { pathname: '/marketplace' },
      matchMedia: (query) => ({ matches: String(query).includes('max-width: 720px') }),
    }),
    false,
  );
  assert.equal(
    selectBandAllowed({ button: 0 }, {
      location: { pathname: '/marketplace' },
      matchMedia: (query) => ({ matches: String(query).includes('pointer: coarse') }),
    }),
    false,
  );
  assert.equal(
    selectBandAllowed({ pointerType: 'mouse' }, {
      location: { pathname: '/profile' },
      matchMedia: () => ({ matches: false }),
    }),
    false,
  );
  const host = readFileSync(new URL('./select-band.jsx', import.meta.url), 'utf8');
  assert.match(host, /selectBandAllowed/);
});

test('ShopList listens on main so a band from empty background can hit listings', () => {
  const host = readFileSync(new URL('./select-band.jsx', import.meta.url), 'utf8');
  assert.match(host, /marqueeStartAllowed/);
  assert.match(host, /listingRects|shop-row/);
  assert.match(host, /SelectBandProvider/);
  assert.match(
    readFileSync(new URL('./components/Chrome.jsx', import.meta.url), 'utf8'),
    /SelectBandProvider/,
  );
});

test('a plain pointer outside selected shop rows clears the selection', () => {
  const selected = new Set(['a', 'b']);
  const selectedRow = { dataset: { listingId: 'a' } };
  const otherRow = { dataset: { listingId: 'c' } };
  const list = { contains: (row) => row === selectedRow || row === otherRow };
  const target = (row) => ({ closest: () => row });

  assert.equal(clearShopSelectionOnPointer(target(selectedRow), list, selected), false);
  assert.equal(clearShopSelectionOnPointer(target(otherRow), list, selected), true);
  assert.equal(clearShopSelectionOnPointer({ closest: () => null }, list, selected), true);
  assert.equal(
    clearShopSelectionOnPointer(target(otherRow), list, selected, { ctrlKey: true }),
    false,
  );
});

test('mixed desk drag piles listings with desk art and related tiles', () => {
  const desk = { id: '100', name: 'Desk Card', canonicalPath: '/c/100' };
  const related = { id: '200', name: 'Related', canonicalPath: '/c/200' };
  const offerA = { id: 'L1', cardId: '100', pricePkn: 10, sellerName: 'A', condition: 'NM' };
  const offerB = { id: 'L2', cardId: '100', pricePkn: 12, sellerName: 'B', condition: 'NM' };
  const catalog = new Map([['100', desk], ['200', related]]);
  const pile = mixedDeskDragReference({
    heldOffer: offerA,
    heldCard: desk,
    offers: [offerA, offerB],
    catalog,
    cardSelected: new Set(['100', '200']),
    listingSelected: new Set(['L1', 'L2']),
    deskCard: desk,
  });
  assert.equal(pile.kind, 'cards');
  assert.equal(pile.cards.length, 4);
  assert.equal(pile.cards[0].listingId, 'L1');
  assert.equal(pile.cards[0].kind, 'listing');
  assert.ok(pile.cards.some((row) => row.listingId === 'L2'));
  assert.ok(pile.cards.some((row) => row.kind === 'card' && row.cardId === '100'));
  assert.ok(pile.cards.some((row) => row.kind === 'card' && row.cardId === '200'));

  const fromArt = mixedDeskDragReference({
    heldCard: desk,
    offers: [offerA, offerB],
    catalog,
    cardSelected: new Set(['100', '200']),
    listingSelected: new Set(['L1']),
    deskCard: desk,
  });
  assert.equal(fromArt.cards[0].cardId, '100');
  assert.equal(fromArt.cards.length, 3);
});
