import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const row = read('./ShopListing.jsx');
const card = read('../../pages/Card.jsx');
const seller = read('../../pages/Seller.jsx');

test('shop listing line never adds to cart on row click — cart icon, buy-btn, or drag', () => {
  assert.equal(row.includes('onBuy'), false);
  assert.match(row, /onCart/);
  assert.match(row, /Add to cart/);
  assert.equal(row.includes('onClick={buy}'), false);
  assert.match(row, /listingsReference/);
  assert.match(row, /writeListingDrag/);
  assert.match(row, /onInspect/);
  assert.match(card, /onCart=\{\(qty\) => addToCart/);
  assert.match(card, /onInspect=\{openZoom\}/);
  assert.match(seller, /onCart=\{\(qty\) =>/);
});

test('shop rows show message + cart icons and a qty picker; drags carry the picked qty', () => {
  assert.match(row, /Message this seller about this listing/);
  assert.match(row, /sellerUid/);
  assert.match(row, /class="ct-qty"/);
  assert.match(row, /choices\(\) > 1/);
  assert.match(row, /class="ct-qty is-single"/);
  assert.equal(row.includes('of {stock'), false);
  assert.match(row, /<ThumbZoom src=\{full\(\)\} full alt=\{props\.name \|\| ''\}>/);
  assert.equal(row.includes("closest?.('.shop-art"), false);
  assert.match(row, /class="art-cut shop-art"/);
  assert.match(row, /qty: pick\(\)/);
  assert.match(row, /writeListingDrag\(event, \{ \.\.\.mixed, qty: pick\(\), stock: choices\(\) \}\)/);
});

test('chat tags carry a qty stepper and a yellow qty badge', () => {
  const tag = read('../ChatListingTag.jsx');
  const stepper = read('../QtyStepper.jsx');
  assert.match(tag, /QtyStepper/);
  assert.match(stepper, /props\.class \?\? 'chat-qty'/);
  assert.match(tag, /class="chat-qty-badge"/);
  assert.equal(tag.includes('footer={quantity}'), false);
});
