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
  assert.match(card, /onCart=\{\(qty\) => addListingToCart\(offer, qty\)\}/);
  assert.match(card, /function addListingToCart\(offer, qty = 1\) \{\s*addToCart\(\{ \.\.\.cartItemFromOffer\(card\(\), snapshot\(offer\)\)/);
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

test('a compact listing line keeps seller, facet, price and qty: no card face, no tags, no photos, no message', () => {
  assert.match(row, /'is-compact': props\.compact/);
  // What the compact line drops is the card column, the extra tags, the seller's
  // own photos and the message button — never the price, the quantity or the cart.
  assert.match(row, /<Show when=\{photos\(\)\.length && !props\.compact\}>/);
  assert.match(row, /!props\.anonymous && !props\.compact/);
  assert.match(row, /<Show when=\{!props\.compact\}>\s*\{\/\* The tags a full Shop row names/);
  assert.match(row, /when=\{props\.showCard\}\s*fallback=\{\(\s*<Show when=\{!props\.anonymous\}/);
  // A single copy is still a quantity: the summary line names it.
  assert.match(row, /fallback=\{<span class="ct-qty is-single" aria-label="Quantity 1">1<\/span>\}/);
  const css = read('../../../../market/src/styles.css');
  assert.match(css, /\.cell-cheap \.shop-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto auto/);
  assert.match(css, /\.cell-cheap \.shop-offer \{[^}]*display: inline-flex/);
  // The list itself is not a grid: a heading and one line per listing, top down.
  assert.match(css, /\.desk-cell \.cell-rows \{[^}]*display: flex/);
});

test('chat tags carry a qty stepper and a yellow qty badge', () => {
  const tag = read('../ChatListingTag.jsx');
  const stepper = read('../QtyStepper.jsx');
  assert.match(tag, /QtyStepper/);
  assert.match(stepper, /props\.class \?\? 'chat-qty'/);
  assert.match(tag, /class="chat-qty-badge"/);
  assert.equal(tag.includes('footer={quantity}'), false);
});
