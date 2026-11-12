import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEAL_BOOK_METRICS, DEAL_BOOK_WIDE_MIN_WIDTH } from './deal-book.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

test('card desk version row cannot overflow past the scan', () => {
  assert.match(css, /\.art-num-row \{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /select\.collector-badge\.version-badge \{[^}]*width:\s*100%/);
  assert.match(css, /select\.collector-badge\.version-badge \{[^}]*min-width:\s*0/);
  assert.match(css, /\.card-page\.flutter-page \{[^}]*overflow-x:\s*clip/);
  assert.match(css, /\.card-desk \{[^}]*min-width:\s*0/);
});

// The App/SearchBox side is guarded in solid/src/components/{Chrome,SearchBox}.test.js.
test('extension side-panel desk clips chrome and keeps the version select shrinking', () => {
  assert.match(css, /html\.is-extension-desk \.foot \{[^}]*display:\s*none/);
  assert.match(css, /html\.is-extension-desk \.art-num-row \{[^}]*2\.25rem minmax\(0,\s*1fr\) 2\.25rem/);
});

test('card desk is one tile, its inner panels are flat, the title tile is borderless and Related cards keeps the panel look', () => {
  const rule = (selector) => {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, selector);
    return css.slice(css.indexOf('{', at), css.indexOf('}', at));
  };
  const flat = 'html:root:root .card-page.flutter-page';
  const tile = rule(`${flat} .card-desk {`);
  assert.match(tile, /background:\s*var\(--g2\)/);
  assert.match(tile, /border:\s*1px solid var\(--g5\)/);
  assert.match(tile, /padding:/);
  assert.match(rule('html.desk-tinted:root:root .card-page.flutter-page .card-desk {'), /background:\s*var\(--desk-surface\)/);
  for (const cls of ['.panel', '.sell-form', '.add-panel', '.reserve-blurb', '.shop-panel']) {
    assert.ok(css.includes(`${flat} .card-desk ${cls}`), cls);
    // Only inside the desk: the flat rule never targets a bare card-page panel.
    assert.ok(!css.includes(`${flat} ${cls}`), `${cls} must stay scoped to .card-desk`);
  }
  const panels = rule(`${flat} .card-desk .shop-panel {`);
  assert.match(panels, /background:\s*transparent/);
  assert.match(panels, /border-color:\s*transparent/);
  assert.match(panels, /box-shadow:\s*none/);
  assert.match(panels, /outline:\s*none/);
  const head = rule(`${flat} .asset-header.shaded {`);
  assert.match(head, /border-color:\s*transparent/);
  assert.match(head, /box-shadow:\s*none/);
  assert.doesNotMatch(head, /background/);
  // Related cards is a plain .panel outside the desk: the shared rule is untouched.
  assert.match(css, /\n\.panel \{\s*background:\s*var\(--g2\);\s*border:\s*1px solid var\(--g5\)/);
});

test('the Shop header shares the desktop row grid, never wraps on phones, and the old select styles are gone', () => {
  assert.match(css, /\.shop-header,\n\s*\.shop-terminal \.shop-row:not\(\.is-profile\) \{[^}]*grid-template-columns:\s*minmax\(9rem, 1\.6fr\) minmax\(0, 1\.3fr\) minmax\(5\.5rem, 1fr\) minmax\(2\.5rem, 0\.5fr\) 4\.25rem/);
  assert.match(css, /\.shop-hseller,\n\s*\.shop-hqty \{ display: none; \}/);
  const phone = css.slice(css.indexOf('.shop-header {\n    flex-wrap: nowrap;'));
  assert.match(phone.slice(0, 120), /flex-wrap:\s*nowrap/);
  assert.doesNotMatch(css, /\.shop-tools/);
});

test('an empty Vault is hidden on phones only', () => {
  const rule = /\.card-page \.vault-panel\.is-empty \{\s*display:\s*none;\s*\}/;
  const at = css.search(rule);
  assert.notEqual(at, -1);
  const before = css.slice(0, at);
  const mq = before.lastIndexOf('@media');
  assert.match(before.slice(mq, mq + 40), /@media \(max-width: 720px\)/);
  // The only rule that targets .is-empty on the Vault is the phone one.
  assert.equal(css.split('.vault-panel.is-empty').length - 1, 1);
});

test('the Vault is its own bordered, raised box inside the flat desk tile; Shop stays transparent', () => {
  assert.match(css, /\.card-desk \.shop-panel \{\s*background: transparent;\s*border-color: transparent;/);
  const box = css.match(/\.card-desk \.vault-panel \{([^}]*)\}/);
  assert.ok(box);
  assert.match(box[1], /background:\s*var\(--g3\)/);
  assert.match(box[1], /border:\s*1px solid var\(--g5\)/);
  assert.match(box[1], /padding:/);
  assert.doesNotMatch(box[1], /box-shadow/);
  assert.match(css, /desk-tinted:root:root \.card-page\.flutter-page \.card-desk \.vault-panel \{\s*background: color-mix\(in srgb, var\(--desk-surface\) 93%, #fff\);\s*border-color: var\(--desk-border\)/);
});

test('the Vault title shares the Seller label style', () => {
  const label = css.match(/\.shop-label \{([^}]*)\}/);
  assert.ok(label);
  for (const rule of [/font-size:\s*0\.72rem/, /font-weight:\s*700/, /letter-spacing:\s*0\.03em/, /text-transform:\s*uppercase/, /gap:\s*0\.35rem/]) {
    assert.match(label[1], rule);
  }
  const header = css.match(/\.shop-header \{([^}]*)\}/)[1];
  assert.match(header, /font-size:\s*0\.72rem/);
  assert.match(header, /letter-spacing:\s*0\.03em/);
});

test('the Best Deal book is measured in whole rows and can never outgrow the centre column', () => {
  const measured = new RegExp(`@media \\(max-width: ${DEAL_BOOK_WIDE_MIN_WIDTH - 1}px\\) \\{[\\s\\S]{0,200}?\\.card-desk`);
  assert.match(css, measured, 'the desk stacks one pixel below the width dealBookMeasured() starts measuring');
  // styles.css sizes the book from the same numbers deal-book.js counts rows with.
  const book = css.slice(css.indexOf('.hero-deal .deal-book {'));
  for (const [key, value] of Object.entries(DEAL_BOOK_METRICS)) {
    assert.match(book, new RegExp(`--deal-book-${key}:\\s*${value}px`), key);
  }
  // The heading, the rows and the See all line are gap-free siblings: each part
  // costs exactly what planDealBook() charges for it, so nothing is ever clipped.
  const list = css.match(/\.deal-book-list \{([^}]*)\}/)[1];
  assert.doesNotMatch(list, /gap:/);
  assert.match(css, /\.deal-book-head \{[^}]*height: var\(--deal-book-head\)/);
  assert.match(css, /\.deal-book-rows \{[^}]*gap: var\(--deal-book-gap\)/);
  assert.match(css, /\.deal-book-more \{[^}]*height: var\(--deal-book-more\)[^}]*padding-top: var\(--deal-book-gap\)/);
  for (const selector of ['.deal-book .shop-row {', '.deal-offer {']) {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, selector);
    assert.match(css.slice(at, css.indexOf('}', at)), /height: var\(--deal-book-row\)/, selector);
  }
  // Only the stretched panel clips: the stacked desk sizes its book to content,
  // so a row there is never cut and never needs a scrollbar.
  const stacked = book.slice(0, book.indexOf('@media'));
  assert.doesNotMatch(stacked, /overflow:/);
  assert.doesNotMatch(stacked, /flex:/);
  const wide = book.slice(book.indexOf(`@media (min-width: ${DEAL_BOOK_WIDE_MIN_WIDTH}px)`));
  assert.match(wide, /\.hero-deal \.deal-book \{\s*flex: 1 1 0;\s*min-height: 0;\s*overflow: hidden;/);
  assert.match(wide, /overflow:\s*hidden/);
});

test('the Buy offers row shares one line box with the seller rows, so both lists count the same', () => {
  assert.match(css, /\.deal-book \.shop-row \{[^}]*padding:\s*0/);
  assert.match(css, /\.deal-book \.shop-seller \{[^}]*flex:\s*1 1 auto/);
});
