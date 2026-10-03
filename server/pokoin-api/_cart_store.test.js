'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cartCardIds,
  cleanCartRow,
  cleanCartState,
  readCart,
  writeCart,
} = require('./_cart_store');

const row = (over = {}) => ({
  id: 'l1',
  listingId: 'l1',
  cardId: '598056',
  name: 'Medicham ex',
  image: '/card-images/299028_medicham-ex.jpg',
  href: '/marketplace/en/cards/598056/medicham-ex',
  pricePkn: 400,
  qty: 1,
  stock: 1,
  sellerUid: 'seller-a',
  ...over,
});

test('cart rows keep only known fields and safe links', () => {
  const clean = cleanCartRow(row({
    href: 'javascript:alert(1)',
    image: 'http://evil.example/x.jpg',
    qty: 500,
    pricePkn: -3,
    extra: 'dropped',
    sellerUsername: '@nez',
  }));
  assert.equal(clean.href, '');
  assert.equal(clean.image, '');
  assert.equal(clean.qty, 99);
  assert.equal(clean.pricePkn, 0);
  assert.equal(clean.sellerUsername, 'nez');
  assert.equal('extra' in clean, false);
  assert.equal(cleanCartRow(row({ href: '//evil.example/x' })).href, '');
  assert.equal(cleanCartRow(row({ image: 'https://cdn.pokoin.com/a.jpg' })).image, 'https://cdn.pokoin.com/a.jpg');
  assert.equal(cleanCartRow(row({ cardId: 'abc' })), null);
  assert.equal(cleanCartRow(row({ id: '' })), null);
  assert.equal(cleanCartRow(null), null);
});

test('cart state dedupes rows, caps lists and collects card ids', () => {
  const state = cleanCartState({
    items: [row(), row(), row({ id: 'l2', cardId: '261346' })],
    saved: [row({ id: 's1', cardId: '247844' })],
    gift: 'true',
  });
  assert.equal(state.items.length, 2);
  assert.equal(state.gift, true);
  assert.deepEqual(cartCardIds(state), ['598056', '261346', '247844']);
  const many = cleanCartState({ items: Array.from({ length: 450 }, (_, i) => row({ id: `x${i}` })) });
  assert.equal(many.items.length, 400);
});

test('reading a missing table is an empty cart', async () => {
  const cart = await readCart(async () => {
    throw Object.assign(new Error('relation "public.marketplace_user_carts" does not exist'), { code: '42P01' });
  }, 'u1');
  assert.deepEqual(cart, { items: [], saved: [], gift: false, rev: 0, updatedAt: null });
});

test('a save based on the current revision wins and bumps it', async () => {
  const calls = [];
  const result = await writeCart(async (sql, values) => {
    calls.push(values);
    return { rows: [{ items: [row()], saved: [], gift: false, rev: 4, updated_at: '2026-10-03T12:00:00Z' }] };
  }, 'u1', { items: [row()] }, 3);
  assert.equal(result.ok, true);
  assert.equal(result.cart.rev, 4);
  assert.equal(calls[0][5], 3);
  assert.deepEqual(calls[0][4], ['598056']);
});

test('a save from a stale revision loses and returns the current cart', async () => {
  let call = 0;
  const result = await writeCart(async () => {
    call += 1;
    if (call === 1) return { rows: [] };
    return { rows: [{ items: [row({ id: 'other' })], saved: [], gift: true, rev: 9, updated_at: null }] };
  }, 'u1', { items: [row()] }, 2);
  assert.equal(result.ok, false);
  assert.equal(result.cart.rev, 9);
  assert.equal(result.cart.items[0].id, 'other');
  assert.equal(result.cart.gift, true);
});
