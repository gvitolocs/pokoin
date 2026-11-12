import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEAL_BOOK_PHONE_MAX_WIDTH } from './deal-book.js';

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

test('the Vault has no hiding rule any more: an empty one is not rendered at all', () => {
  // Replaces the phone-only `.is-empty` display rule: the row is now conditional
  // markup, so there is no empty box to hide at any width (see Card.test.js for
  // the `<Show when={split().vault.length}>` pin).
  assert.doesNotMatch(css, /vault-panel\.is-empty/);
  assert.doesNotMatch(css, /\.vault-panel \{[^}]*display:\s*none/);
});

test('the Vault and the listing cells are their own bordered, raised boxes inside the flat desk tile; Shop stays transparent', () => {
  assert.match(css, /\.card-desk \.shop-panel \{\s*background: transparent;\s*border-color: transparent;/);
  const box = css.match(/\.card-desk \.vault-panel,\s*[^{]*\.desk-cell \{([^}]*)\}/);
  assert.ok(box, 'the raised box rule must cover both the Vault and the two cells');
  assert.match(box[1], /background:\s*var\(--g3\)/);
  assert.match(box[1], /border:\s*1px solid var\(--g5\)/);
  assert.match(box[1], /padding:/);
  assert.doesNotMatch(box[1], /box-shadow/);
  assert.match(css, /desk-tinted:root:root \.card-page\.flutter-page \.card-desk \.vault-panel,\s*[^{]*\.desk-cell \{\s*background: color-mix\(in srgb, var\(--desk-surface\) 93%, #fff\);\s*border-color: var\(--desk-border\)/);
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

test('the desk is one grid: art for the whole height, the band on top, graph beside the form, the two cells beside each other', () => {
  const desk = css.match(/\n\.card-desk \{([^}]*)\}/)[1];
  assert.match(desk, /display:\s*grid/);
  assert.match(desk, /grid-template-columns:\s*300px minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(desk, /grid-template-areas:\s*"art band band"\s*"art graph form"\s*"art cheap offers"/);
  // An empty named area still costs a track and a gap, so the two optional rows
  // (Vault, full Shop) must stay out of the map and place themselves instead.
  assert.doesNotMatch(desk, /vault|shop/, 'Vault and Shop must not be declared grid areas');

  const area = (cls, name) => {
    const at = css.indexOf(`\n${cls} {`);
    assert.notEqual(at, -1, cls);
    assert.match(css.slice(at, css.indexOf('}', at)), new RegExp(`grid-area: ${name}`), `${cls} grid-area`);
  };
  area('.hero-art-col', 'art');
  area('.desk-band', 'band');
  area('.desk-graph', 'graph');
  area('.desk-form', 'form');
  area('.cell-cheap', 'cheap');
  area('.cell-offers', 'offers');

  // The optional rows span every column, as rows of their own.
  assert.match(css, /\.card-desk > \.vault-panel,\s*\.card-desk > \.shop-terminal \{\s*grid-column: 1 \/ -1/);
});

test('rows size to their content: the cells hug theirs and only the graph stretches', () => {
  // No column left with a hole inside a bordered box.
  for (const cls of ['.cell-cheap', '.cell-offers', '.desk-band']) {
    const at = css.indexOf(`\n${cls} {`);
    assert.notEqual(at, -1, cls);
    assert.match(css.slice(at, css.indexOf('}', at)), /align-self:\s*start/, `${cls} must not stretch`);
  }
  // The listing form is the tall one; the graph takes whatever height the row has.
  const graph = css.match(/\.desk-graph \.sold-graph \{([^}]*)\}/)[1];
  assert.match(graph, /flex:\s*1 1 auto/);
  assert.match(graph, /max-height:\s*none/);
  // The art column is the one element allowed to span rows, and its shortcuts
  // sink to the bottom so the long left column ends on something.
  assert.match(css, /\.hero-art-col \.art-panel \{[^}]*flex:\s*1/);
  assert.match(css, /\.hero-art-col \.version-links \{[^}]*margin-top:\s*auto/);
});

test('the price band is one strip: a label line, then price + chips, then the buy side', () => {
  const main = css.match(/\.band-main \{([^}]*)\}/)[1];
  assert.match(main, /display:\s*flex/);
  assert.match(main, /flex-wrap:\s*wrap/);
  // The buy side always starts its own line, right-aligned: the band is two
  // content lines at every desk width, never a price line the chips fall off.
  const actions = css.match(/^\.band-actions \{([^}]*)\}/m)[1];
  assert.match(actions, /flex:\s*1 1 100%/);
  assert.match(actions, /justify-content:\s*flex-end/);
  // The chips share the price line at any width: their base is zero, so they
  // fold inside their own box instead of pushing the row count up.
  const facets = css.match(/\.desk-band \.deal-facets \{([^}]*)\}/)[1];
  assert.match(facets, /flex-direction:\s*row/);
  assert.match(facets, /flex:\s*1 1 0/);
  assert.match(facets, /min-width:\s*0/);
  assert.doesNotMatch(facets, /width:\s*100%/);
  // Both chip rows drop the rail's full-width grids: five images that fit, and a
  // language row that folds (a western printing names nine codes).
  const conds = css.match(/\.desk-band \.deal-facet-row\[aria-label="Condition"\] \{([^}]*)\}/)[1];
  assert.match(conds, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*2\.6rem\)\)/);
  const langs = css.match(/\.desk-band \.deal-facet-row\[aria-label="Language"\] \{([^}]*)\}/)[1];
  assert.match(langs, /display:\s*flex/);
  assert.match(langs, /flex-wrap:\s*wrap/);
  // The buy side keeps the heights it had in the old column.
  assert.match(css, /\.band-actions \.offer-wrap \{ flex: none; \}/);
  assert.match(css, /\.band-actions \.buy-btn \{ width: auto;/);
});

test('phones restack the desk in the order the owner asked for', () => {
  const at = css.indexOf('@media (max-width: 720px) {\n  .card-desk {\n    grid-template-columns: 1fr;');
  assert.notEqual(at, -1, 'the phone restack must be the desk rule inside the 720 block');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(
    block,
    /grid-template-areas:\s*"art"\s*"band"\s*"cheap"\s*"offers"\s*"graph"\s*"form"/,
  );
  // The band cannot keep one line: price, chips, offer bar and cart each take a row.
  assert.match(css, /\.desk-band \.band-main \{\s*flex-direction: column;\s*align-items: stretch;/);
  assert.match(css, /\.desk-band \.band-actions \{[^}]*flex-direction: column;/);
  // Stacked, neither box keeps the desktop line-splitting flex.
  assert.match(css, /\.desk-band \.band-actions \{[^}]*flex:\s*none/);
  assert.match(css, /\.desk-band \.deal-facets \{[^}]*flex:\s*none/);
  // and the chips go back to the rail's full-width rows, inside this block.
  assert.match(css.slice(at), /\.desk-band \.deal-facets \{[^}]*flex-direction:\s*column/);
});

test('the row cap deal-book.js counts with is the width the desk restacks at', () => {
  assert.equal(DEAL_BOOK_PHONE_MAX_WIDTH, 720);
  assert.match(css, /@media \(max-width: 720px\) \{\s*\n\s*\.card-desk \{\s*\n\s*grid-template-columns: 1fr/);
});

test('the listing cells are one line per row and the offer line shares their height', () => {
  // The compact line is the Shop's own parts, laid out as a row of the cell.
  const row = css.match(/\.cell-cheap \.shop-row \{([^}]*)\}/)[1];
  assert.match(row, /display:\s*grid/);
  assert.match(row, /grid-template-columns:\s*minmax\(0, 1fr\) auto auto auto/);
  assert.match(row, /padding:\s*0/);
  assert.match(row, /min-height:\s*2\.4rem/);
  assert.match(css, /\.cell-cheap \.shop-offer \{[^}]*display: inline-flex/);
  // One line per offer, and it is as tall as a listing line.
  const offer = css.match(/\.deal-offer \{([^}]*)\}/)[1];
  assert.match(offer, /min-height:\s*2\.4rem/);
  assert.match(offer, /display:\s*flex/);
});

test('a narrow desktop keeps the graph readable: tightened filters, then the graph takes its row', () => {
  // Half a desk is not enough for the overlay filter line at its desktop size.
  const at = css.indexOf('@media (max-width: 1200px) {');
  const tight = css.slice(at, css.indexOf('\n}', at));
  assert.match(tight, /\.sold-graph-filters select \{[^}]*flex:\s*1 1 0/);
  assert.match(tight, /\.sold-graph-filters select,\s*\.sold-graph-filters button,\s*\.sold-graph-units \{[^}]*font-size: 0\.64rem/);
  const stack = css.slice(css.indexOf('@media (max-width: 1000px) {'));
  assert.match(
    stack,
    /grid-template-areas:\s*"art band band"\s*"graph graph graph"\s*"form form form"\s*"cheap cheap cheap"\s*"offers offers offers"/,
  );
  // The art column stops spanning here: beside five stacked rows it would be one long strip.
  assert.doesNotMatch(stack.slice(0, 600), /"art graph/);
  // The phone restack (720) still wins over this one, so it must come later.
  assert.ok(
    css.indexOf('@media (max-width: 1000px) {')
      < css.indexOf('@media (max-width: 720px) {\n  .card-desk {\n    grid-template-columns: 1fr;'),
    'the 1000px stack must precede the phone restack so the phone wins below 720',
  );
});
