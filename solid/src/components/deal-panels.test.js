import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const cells = read('./deal/BuyOffers.jsx');
const bar = read('./desk/OfferBar.jsx');
const css = read('../../../market/src/styles.css');

/**
 * CARD-01 P4, the two buy-side panels. The house line is a client constant, so
 * both panels must show it in the frame the desk paints, not in the frame its
 * `marketplace-buy-orders` answer arrives — and the row it later gives up to a
 * real offer must cost the same, or the pair moves (P3).
 */
test('the Buy offers cell paints Pokoin line with nothing known about the book', () => {
  // The gate is the row list, which `createBuyBook` seeds to `[]` on a card this
  // device has never seen: `known()` is false here and the line is still there.
  assert.match(cells, /<Show\s+when=\{Array\.isArray\(book\(\)\)\}\s+fallback=\{\(/);
  assert.doesNotMatch(cells, /<Show\s+when=\{props\.buy\.known\(\)/);
  assert.match(cells, /when=\{rows\(\)\.length\}\s+fallback=\{\(\s*<p class="cell-empty">/);
  assert.match(cells, /Pokoin buys it for \$\{offerPriceLabel\(HOUSE_OFFER_PKN, buyerCurrency\(props\.pinned\) \|\| 'PKN'\)\}/);
  assert.match(cells, /sellTarget\(\{ house: true \}, \{ condition: props\.condition, language: props\.language \}\)/);
  assert.match(cells, /props\.buy\.askOffer\(\)/);
});

test('one offer row replaces that line without changing the cell height', () => {
  // The line and the row are the same box, and the cell body is at least that box
  // from the first frame — so neither the answer nor the wait can move the pair.
  assert.match(css, /\.desk-cell > :not\(\.cell-title\) \{ min-height: 2\.4rem; \}/);
  const offer = css.match(/\.deal-offer \{([^}]*)\}/)[1];
  assert.match(offer, /min-height:\s*2\.4rem/);
});

test('the offer bar and the sell strip wait for the flag, never for rows that are not coming', () => {
  assert.match(bar, /const loading = \(\) => !buy\.known\(\);/);
  assert.match(bar, /class=\{\['offer-wrap', \{ 'is-above': props\.above, 'is-loading': loading\(\) \}\]\}/);
  // The bar is mounted whatever the book says: it used to mount only once it answered.
  assert.doesNotMatch(bar, /<Show when=\{book\(\)\}>/);
});
