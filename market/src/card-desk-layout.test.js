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

test('card desk panels are transparent and borderless, the title tile keeps its background and has no border', () => {
  const rule = (selector) => {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, selector);
    return css.slice(css.indexOf('{', at), css.indexOf('}', at));
  };
  const flat = 'html:root:root .card-page.flutter-page';
  for (const cls of ['.panel', '.sell-form', '.add-panel', '.reserve-blurb', '.shop-panel']) {
    assert.ok(css.includes(`${flat} ${cls}`), cls);
  }
  const panels = rule(`${flat} .shop-panel {`);
  assert.match(panels, /background:\s*transparent/);
  assert.match(panels, /border-color:\s*transparent/);
  assert.match(panels, /box-shadow:\s*none/);
  assert.match(panels, /outline:\s*none/);
  const head = rule(`${flat} .asset-header.shaded {`);
  assert.match(head, /border-color:\s*transparent/);
  assert.match(head, /box-shadow:\s*none/);
  assert.doesNotMatch(head, /background/);
  // Scoped to the card page: the shared .panel rule is untouched.
  assert.match(css, /\n\.panel \{\s*background:\s*var\(--g2\);\s*border:\s*1px solid var\(--g5\)/);
});
