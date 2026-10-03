import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buyAgainCards,
  carouselPage,
  cartSignature,
  cartTotals,
  cheaperCopy,
  groupBySeller,
  isSelected,
  liveMessages,
  mergeCartStates,
  moveRow,
  nextSelectAll,
  parcelEstimate,
  parcelNudge,
  priceDrop,
  purchasedLabel,
  reconcileRow,
  settleCheckoutRows,
  shippingEstimate,
} from './cart-model.js';

const row = (over = {}) => ({
  id: 'l1',
  listingId: 'l1',
  cardId: '100',
  name: 'Umbreon VMAX',
  sellerUid: 'seller-a',
  sellerName: 'nez',
  sellerCountry: 'IT',
  condition: 'Near Mint',
  language: 'en',
  pricePkn: 2642,
  qty: 1,
  stock: 3,
  ...over,
});

test('rows are selected unless explicitly unticked', () => {
  assert.equal(isSelected({}), true);
  assert.equal(isSelected({ selected: true }), true);
  assert.equal(isSelected({ selected: false }), false);
});

test('subtotal counts only ticked rows while the badge counts every copy', () => {
  const items = [
    row({ id: 'a', pricePkn: 1000, qty: 2 }),
    row({ id: 'b', pricePkn: 500, qty: 1, selected: false }),
    row({ id: 'c', pricePkn: 300, qty: 3 }),
  ];
  const totals = cartTotals(items);
  assert.equal(totals.count, 6);
  assert.equal(totals.subtotalPkn, 3400);
  assert.equal(totals.selectedCount, 5);
  assert.equal(totals.selectedSubtotalPkn, 2900);
  assert.equal(totals.selectedLines, 2);
  assert.equal(totals.allSelected, false);
});

test('Deselect all only when every row is ticked', () => {
  assert.equal(nextSelectAll([row(), row({ id: 'b' })]), false);
  assert.equal(nextSelectAll([row(), row({ id: 'b', selected: false })]), true);
  assert.equal(nextSelectAll([]), true);
});

test('rows group into one parcel per seller in first-seen order', () => {
  const groups = groupBySeller([
    row({ id: 'a', sellerUid: 's1', qty: 2 }),
    row({ id: 'b', sellerUid: 's2', sellerCountry: 'DE' }),
    row({ id: 'c', sellerUid: 's1', qty: 1, selected: false }),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['s1', 's2']);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].selectedCount, 2);
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[1].sellerCountry, 'DE');
});

test('a small parcel previews the untracked letter and the room left at that price', () => {
  // IT→DK: SMALL and MEDIUM letters cost the same (4.35 €), LARGE does not.
  const estimate = parcelEstimate({ from: 'IT', to: 'DK', cards: 2 });
  assert.equal(estimate.tracked, false);
  assert.equal(estimate.amountCents, 435);
  assert.equal(estimate.room, 18);
  assert.equal(parcelEstimate({ from: 'IT', to: 'DK', cards: 0 }), null);
  assert.equal(parcelEstimate({ from: 'EU', to: 'DK', cards: 1 }), null);
  assert.equal(parcelEstimate({ from: '', to: 'DK', cards: 1 }), null);
});

test('shipping estimate is one parcel per seller with ticked cards', () => {
  const groups = groupBySeller([
    row({ id: 'a', sellerUid: 's1', sellerCountry: 'IT', qty: 2 }),
    row({ id: 'b', sellerUid: 's2', sellerCountry: 'IT', selected: false }),
    row({ id: 'c', sellerUid: 's3', sellerCountry: '' }),
  ]);
  const estimate = shippingEstimate(groups, 'DK');
  assert.equal(estimate.count, 2);
  assert.equal(estimate.cents, 435);
  assert.equal(estimate.missing, 1);
  const nudge = parcelNudge(groups, 'DK');
  assert.equal(nudge.group.key, 's1');
  assert.equal(nudge.estimate.room, 18);
});

test('reconcile takes the live price and stock and caps the quantity', () => {
  const result = reconcileRow(row({ qty: 3, stock: 3 }), [
    { id: 'l1', pricePkn: 2800, quantityAvailable: 2, condition: 'Near Mint', language: 'en' },
  ]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.patch, { pricePkn: 2800, stock: 2, qty: 2 });
  assert.deepEqual(result.priceChange, { from: 2642, to: 2800 });
  assert.deepEqual(result.qtyCapped, { from: 3, to: 2 });
});

test('a listing missing from the whole book is gone and unticked', () => {
  const result = reconcileRow(row(), [
    { id: 'l9', sellerUid: 'seller-b', pricePkn: 3000, quantityAvailable: 1, condition: 'NM', language: 'en' },
  ]);
  assert.equal(result.status, 'gone');
  assert.deepEqual(result.patch, { unavailable: true, selected: false });
  // The replacement is the cheapest equivalent copy at any price.
  assert.equal(result.cheaper.id, 'l9');
});

test('a miss in a truncated book stays unknown and changes nothing', () => {
  const result = reconcileRow(row(), [], { complete: false });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.patch, {});
});

test('a listing back on sale clears the unavailable flag', () => {
  const result = reconcileRow(row({ unavailable: true, selected: false }), [
    { id: 'l1', pricePkn: 2642, quantityAvailable: 3 },
  ]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.patch, { unavailable: false });
});

test('cheaper copy must match condition, language and finish', () => {
  const listings = [
    { id: 'l2', sellerUid: 's2', pricePkn: 2000, quantityAvailable: 1, condition: 'Played', language: 'en' },
    { id: 'l3', sellerUid: 's3', pricePkn: 2100, quantityAvailable: 1, condition: 'Near Mint', language: 'jp' },
    { id: 'l4', sellerUid: 's4', pricePkn: 2200, quantityAvailable: 1, condition: 'Near Mint', language: 'en', reverse: true },
    { id: 'l5', sellerUid: 's5', pricePkn: 2400, quantityAvailable: 1, condition: 'NM', language: 'EN' },
    { id: 'l6', sellerUid: 's6', pricePkn: 2300, quantityAvailable: 0, condition: 'NM', language: 'en' },
  ];
  assert.equal(cheaperCopy(row(), listings).id, 'l5');
  assert.equal(cheaperCopy(row({ pricePkn: 2400 }), listings), null);
  assert.equal(cheaperCopy(row(), listings, { excludeSellerUid: 's5' }), null);
});

test('live messages report price moves, capped quantities and sold copies once', () => {
  const entry = {
    complete: true,
    listings: [
      { id: 'a', pricePkn: 1200, quantityAvailable: 1 },
      { id: 'b', pricePkn: 400, quantityAvailable: 5 },
    ],
  };
  const notes = liveMessages([
    row({ id: 'a', listingId: 'a', pricePkn: 1000, qty: 2 }),
    row({ id: 'b', listingId: 'b', pricePkn: 500 }),
    row({ id: 'c', listingId: 'c' }),
    row({ id: 'd', listingId: 'd', unavailable: true, selected: false }),
  ], entry);
  assert.deepEqual(notes.map((n) => [n.id, n.kind, n.from ?? null, n.to ?? null]), [
    ['a:price', 'price_up', 1000, 1200],
    ['a:qty', 'qty', 2, 1],
    ['b:price', 'price_down', 500, 400],
    ['c:gone', 'gone', null, null],
  ]);
});

test('price drop compares with the price when the copy went in the cart', () => {
  assert.deepEqual(priceDrop({ addedPricePkn: 1000, pricePkn: 850 }), { was: 1000, now: 850, percent: 15 });
  assert.equal(priceDrop({ addedPricePkn: 1000, pricePkn: 1000 }), null);
  assert.equal(priceDrop({ addedPricePkn: 1000, pricePkn: 1200 }), null);
  assert.equal(priceDrop({ pricePkn: 900 }), null);
});

test('save for later moves a row to the top of the other list', () => {
  const moved = moveRow([row({ id: 'a' }), row({ id: 'b' })], [row({ id: 'c' })], 'b');
  assert.deepEqual(moved.from.map((r) => r.id), ['a']);
  assert.deepEqual(moved.to.map((r) => r.id), ['b', 'c']);
  assert.equal(moved.row.id, 'b');
  const missing = moveRow([row({ id: 'a' })], [], 'zz');
  assert.equal(missing.row, null);
  assert.equal(missing.from.length, 1);
});

test('a finished checkout removes the rows it sent or the paid listings, never a guess', () => {
  const items = [
    row({ id: 'a', listingId: 'a' }),
    row({ id: 'b', listingId: 'b', selected: false }),
    row({ id: 'c', listingId: 'c' }),
  ];
  assert.deepEqual(settleCheckoutRows(items, { rowIds: ['a'] }).map((r) => r.id), ['b', 'c']);
  assert.deepEqual(settleCheckoutRows(items, { listingIds: ['c'] }).map((r) => r.id), ['a', 'b']);
  assert.equal(settleCheckoutRows(items, {}), items);
  assert.equal(settleCheckoutRows(items, { rowIds: ['zz'] }), items);
});

test('buy it again lists paid cards once, newest purchase first', () => {
  const cards = buyAgainCards([
    { paymentStatus: 'paid', createdAt: '2026-08-01T00:00:00Z', items: [{ card: { id: '1', name: 'Pikachu' } }, { card: { id: '2', name: 'Eevee' } }] },
    { paymentStatus: 'expired', createdAt: '2026-09-20T00:00:00Z', items: [{ card: { id: '3', name: 'Mew' } }] },
    { paymentStatus: 'released', createdAt: { seconds: Date.parse('2026-09-01T00:00:00Z') / 1000 }, items: [{ cardId: '2', cardName: 'Eevee' }] },
  ]);
  assert.deepEqual(cards.map((c) => c.cardId), ['2', '1']);
  assert.equal(purchasedLabel(cards[0].purchasedAt), 'Purchased Sep 2026');
  assert.equal(purchasedLabel(0), '');
});

test('carousel pages follow the scroll position', () => {
  assert.deepEqual(carouselPage({ scrollLeft: 0, clientWidth: 800, scrollWidth: 2000 }), { page: 1, pages: 3 });
  assert.deepEqual(carouselPage({ scrollLeft: 800, clientWidth: 800, scrollWidth: 2000 }), { page: 2, pages: 3 });
  assert.deepEqual(carouselPage({ scrollLeft: 1200, clientWidth: 800, scrollWidth: 2000 }), { page: 3, pages: 3 });
  assert.deepEqual(carouselPage({ scrollLeft: 0, clientWidth: 800, scrollWidth: 600 }), { page: 1, pages: 1 });
  assert.deepEqual(carouselPage({}), { page: 1, pages: 1 });
});

test('account cart wins when this browser has nothing unsynced', () => {
  const local = { items: [row({ id: 'a' })], saved: [], gift: false };
  const remote = { items: [row({ id: 'b' })], saved: [], gift: true, rev: 5 };
  const { state, save } = mergeCartStates(local, remote, { uid: 'u1', rev: 4, dirty: false }, 'u1');
  assert.deepEqual(state.items.map((r) => r.id), ['b']);
  assert.equal(state.gift, true);
  assert.equal(save, false);
});

test('an older account copy (replica lag) never overwrites a newer local save', () => {
  const local = { items: [row({ id: 'a' })], saved: [], gift: false };
  const { state, save } = mergeCartStates(local, { items: [], saved: [], rev: 3 }, { uid: 'u1', rev: 4 }, 'u1');
  assert.deepEqual(state.items.map((r) => r.id), ['a']);
  assert.equal(save, false);
});

test('a guest cart or unsynced edits join the account cart, browser copy first', () => {
  const local = { items: [row({ id: 'a', qty: 2 }), row({ id: 'c' })], saved: [row({ id: 's' })], gift: false };
  const remote = { items: [row({ id: 'b' }), row({ id: 'a', qty: 1 })], saved: [row({ id: 'c' })], gift: false, rev: 2 };
  const guest = mergeCartStates(local, remote, {}, 'u1');
  assert.deepEqual(guest.state.items.map((r) => [r.id, r.qty]), [['a', 2], ['c', 1], ['b', 1]]);
  // A line in the cart is not also kept in Saved for later.
  assert.deepEqual(guest.state.saved.map((r) => r.id), ['s']);
  assert.equal(guest.save, true);
  const dirty = mergeCartStates(local, remote, { uid: 'u1', rev: 2, dirty: true }, 'u1');
  assert.equal(dirty.save, true);
});

test('another account never inherits this browser cart', () => {
  const local = { items: [row({ id: 'a' })], saved: [], gift: false };
  const { state, save } = mergeCartStates(local, { items: [], saved: [], rev: 0 }, { uid: 'someone-else', rev: 9 }, 'u1');
  assert.deepEqual(state.items, []);
  assert.equal(save, false);
});

test('an empty guest browser adopts the account cart without saving', () => {
  const { state, save } = mergeCartStates({ items: [], saved: [], gift: false }, { items: [row({ id: 'b' })], saved: [], rev: 1 }, {}, 'u1');
  assert.deepEqual(state.items.map((r) => r.id), ['b']);
  assert.equal(save, false);
});

test('cart signature changes with lines, saved and gift', () => {
  const base = { items: [row()], saved: [], gift: false };
  assert.equal(cartSignature(base), cartSignature({ ...base }));
  assert.notEqual(cartSignature(base), cartSignature({ ...base, gift: true }));
  assert.notEqual(cartSignature(base), cartSignature({ ...base, items: [row({ qty: 2 })] }));
});

