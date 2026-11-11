import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
