import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeShippingChoice,
  moveSavedIntoCart,
  replaceCartRow,
  restoreCartRow,
  restoreCartRows,
  selectAllCartRows,
} from './cart-row-edits.js';
import { cartTotals } from './cart-totals.js';
import { cartTotals as modelTotals, patchLiveRows } from './cart-model.js';
import {
  checkoutSellerKey,
  checkoutSellerParcels,
  checkoutShipOptions,
  checkoutShippingPreviewCents,
  pknEligibleSubtotal,
  stripeSessionError,
} from './checkout-model.js';
import { mergeOrders, orderFlags, orderItemsTitle, saleNeedsShip, salesTotals } from './order-rows.js';
import { swapPoolsOf } from './wallet-tx.js';
import { liveShippingServices, tickedShippingGroups } from './live-shipping.js';
import { inspiredNames, recommendationInputs, shelfSellers } from './cart-rails-core.js';
import { removedNoteSlot } from './basket-format.js';

const row = (id, extra = {}) => ({ id, cardId: `c${id}`, listingId: `l${id}`, pricePkn: 100, qty: 1, stock: 3, ...extra });

test('cart-totals is the same function cart-model re-exports', () => {
  assert.equal(cartTotals, modelTotals);
  assert.equal(cartTotals([row('a', { qty: 2 }), row('b', { selected: false })]).selectedCount, 2);
});

test('restore puts a deleted row back at its index, never twice', () => {
  const items = [row('a'), row('c')];
  assert.deepEqual(restoreCartRow(items, row('b'), 1).map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(restoreCartRow(items, row('a'), 0), items);
  assert.deepEqual(restoreCartRows([row('x')], [row('x'), row('y')]).map((r) => r.id), ['x', 'y']);
});

test('replace keeps place, tick and the first price; a twin gains qty', () => {
  const items = [row('a', { addedPricePkn: 150 }), row('b')];
  const swapped = replaceCartRow(items, 'a', row('n', { pricePkn: 80, stock: 5 }));
  assert.deepEqual(swapped.map((r) => r.id), ['n', 'b']);
  assert.equal(swapped[0].addedPricePkn, 150);
  const twin = replaceCartRow(items, 'a', row('b'));
  assert.deepEqual(twin.map((r) => [r.id, r.qty]), [['b', 2]]);
});

test('select all leaves sold-out rows unticked; saved rows move back on top', () => {
  const ticked = selectAllCartRows([row('a', { selected: false }), row('b', { unavailable: true })], true);
  assert.deepEqual(ticked.map((r) => r.selected), [true, false]);
  assert.deepEqual(moveSavedIntoCart([row('a')], row('s')).map((r) => r.id), ['s', 'a']);
});

test('shipping choice merge keeps identity when nothing changed', () => {
  const current = { country: 'DK', service: 'tracked' };
  assert.equal(mergeShippingChoice(current, { country: 'DK' }), current);
  assert.deepEqual(mergeShippingChoice(current, { country: 'it' }), { country: 'IT', service: 'tracked', parcels: {} });
});

test('shipping choice keeps a service per seller parcel; a new country clears them', () => {
  const start = { country: 'DK', service: '', parcels: {} };
  const one = mergeShippingChoice(start, { parcel: { key: 'seller-a', service: 'untracked' } });
  assert.deepEqual(one.parcels, { 'seller-a': 'untracked' });
  const two = mergeShippingChoice(one, { parcel: { key: 'seller-b', service: 'packlink:22131' } });
  assert.deepEqual(two.parcels, { 'seller-a': 'untracked', 'seller-b': 'packlink:22131' });
  assert.equal(mergeShippingChoice(two, { parcel: { key: 'seller-a', service: 'untracked' } }), two);
  assert.deepEqual(mergeShippingChoice(two, { country: 'IT' }).parcels, {});
});

test('patchLiveRows marks a vanished copy and keeps the array when nothing moved', () => {
  const items = [row('a', { cardId: 'x', listingId: 'gone' })];
  const next = patchLiveRows(items, 'x', { listings: [], complete: true });
  assert.equal(next[0].unavailable, true);
  assert.equal(next[0].selected, false);
  assert.equal(patchLiveRows(items, 'other', { listings: [] }), items);
});

test('checkout parcels group by seller with the profile origin first', () => {
  const items = [row('a', { sellerUid: 's1', sellerCountry: 'it', qty: 2 }), row('b', { sellerUid: 's1' }), row('c', { sellerUid: 's2', sellerCountry: 'DE' })];
  const parcels = checkoutSellerParcels(items, { s2: 'fr' });
  assert.deepEqual(parcels.map((p) => [p.sellerId, p.count, p.from]), [['s1', 3, 'IT'], ['s2', 1, 'FR']]);
  assert.equal(checkoutSellerKey(items), 's1,s2');
  assert.equal(pknEligibleSubtotal(items, [{ uid: 's2' }]), 300);
  assert.equal(checkoutShippingPreviewCents({ nft: false, itemCount: 1, quote: { shippingTotalCents: 450 } }), 450);
  assert.equal(checkoutShippingPreviewCents({ nft: false, itemCount: 1, quote: null, sellerParcels: [{ from: '' }] }), null);
  assert.match(stripeSessionError({ status: 409, message: 'Price changed.' }), /nothing was charged/);
});

test('order rows: merge newest first, flags and titles', () => {
  const rows = mergeOrders(
    [{ id: 'o1', createdAt: '2026-09-01', uid: 'u' }],
    [{ id: 'o2', createdAt: '2026-10-01', sellerUids: ['u'] }, { id: 'o1', createdAt: '2026-09-01', uid: 'u' }],
  );
  assert.deepEqual(rows.map((r) => r.id), ['o2', 'o1']);
  assert.equal(orderFlags(rows[0], 'u').seller, true);
  assert.equal(orderItemsTitle({ id: 'x', items: [{ cardName: 'A' }, {}, {}] }), 'A +2');
  assert.equal(saleNeedsShip({ source: 'pokoin', paymentStatus: 'paid' }), true);
  assert.equal(saleNeedsShip({ source: 'cardtrader', paymentStatus: 'paid' }), false);
  const totals = salesTotals([
    { currency: 'EUR', gross: 1000, refunded: 100, paymentStatus: 'paid', items: [{ quantity: 2 }] },
    { currency: 'PKN', gross: 50, refunded: 0, paymentStatus: 'cancelled', items: [{ quantity: 1 }] },
  ]);
  assert.deepEqual([totals.count, totals.units, totals.eurNet, totals.pknNet], [1, 2, 900, 0]);
});

test('swap pools always list WPKN', () => {
  assert.deepEqual(swapPoolsOf({ pools: [{ id: 'USDT-PKN' }] }).map((r) => r.asset), ['USDT', 'WPKN']);
});

test('live shipping: complete services first, then cheapest', () => {
  const ticked = tickedShippingGroups([{ key: 'a', selectedCount: 1, sellerCountry: 'IT' }, { key: 'b', selectedCount: 0, sellerCountry: 'DE' }]);
  assert.deepEqual(ticked.map((g) => g.key), ['a']);
  const services = liveShippingServices({
    liveByKey: new Map([['a', [{ id: 'tracked', amountCents: 500 }, { id: 'untracked', amountCents: 300, tracked: false }]]]),
    seedServices: [],
    ticked,
    allowUntracked: true,
  });
  assert.deepEqual(services.map((s) => s.id), ['untracked', 'tracked']);
});

test('cart rails inputs', () => {
  assert.deepEqual(inspiredNames([{ name: 'Pikachu' }, { name: 'pikachu' }, { name: 'Eevee' }, { name: 'Mew' }]), ['Pikachu', 'Eevee']);
  assert.equal(shelfSellers([{ key: 'k', sellerUsername: 'Ash', subtotalPkn: 1 }]).length, 1);
  const inputs = recommendationInputs({ items: [row('a', { sellerUid: 's' })], recentIds: ['1'], watchIds: [], signedIn: true });
  assert.deepEqual(inputs.sellers, ['s']);
  assert.match(inputs.key, /\|in$/);
});

test('removed note sits before the next row of that seller', () => {
  const groups = [{ key: 'g', rows: [row('a'), row('c')] }];
  const slot = removedNoteSlot({ row: row('b'), index: 1 }, groups, [row('a'), row('c')], () => 'g');
  assert.deepEqual(slot, { groupKey: 'g', beforeId: 'c' });
});

test('checkout prices every seller parcel on its own lane, not the first one only', () => {
  const sellerParcels = [
    { sellerId: 'a', sellerName: 'redshakkio', count: 1, from: 'IT' },
    { sellerId: 'b', sellerName: 'givi', count: 1, from: 'DK' },
  ];
  const options = checkoutShipOptions({ nft: false, sellerParcels, buyerCountry: 'DK', allowUntracked: true });
  const bookable = options.filter((row) => !row.unavailable);
  assert.ok(bookable.length >= 1);
  for (const option of bookable) {
    assert.equal(option.parcels.length, 2);
    assert.deepEqual(option.parcels.map((p) => p.fromCountry), ['IT', 'DK']);
    assert.equal(option.amountCents, option.parcels[0].amountCents + option.parcels[1].amountCents);
    const cents = checkoutShippingPreviewCents({
      nft: false, itemCount: 2, quote: null, sellerParcels, buyerCountry: 'DK', tracked: option.tracked,
    });
    assert.equal(option.amountCents, cents);
  }
});
