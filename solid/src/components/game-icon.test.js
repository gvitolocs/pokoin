import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

/** One CSS rule, by the text it starts with. */
const rule = (sheet, selector) => {
  const match = sheet.match(new RegExp(`${selector}[^{]*\\{[^}]*\\}`));
  assert.ok(match, `${selector} is styled`);
  return match[0];
};

const nav = read('./NavPreviews.jsx');
const toggles = read('./SearchToggles.jsx');
const styles = read('../../../market/src/styles.css');
const searchBox = read('../../../market/src/search-box.css');

const marketPreview = () => {
  const from = nav.indexOf('export function MarketPreview');
  const to = nav.indexOf('export function MessagesPreview');
  assert.ok(from !== -1 && to > from, 'MarketPreview is in NavPreviews.jsx');
  return nav.slice(from, to);
};

test('the Card games hover card shares its icon with the name of every game', () => {
  const preview = marketPreview();
  assert.match(preview, /<For each=\{others\(\)\}>/);
  assert.match(preview, /class="nav-preview-games"/);
  assert.match(preview, /aria-label="Card games"/);
  // Icon first, then the label, in the same row.
  assert.match(preview, /<a class="nav-game" href=\{gamePreviewHref\(row\.id\)\}>\s*<GameIcon game=\{row\} \/>\s*<span class="nav-game-name">\{row\.name\}<\/span>/s);
});

test('NavPreviews takes GameIcon from the search toggles, not a copy', () => {
  assert.match(nav, /import \{ GameIcon \} from '\.\/SearchToggles\.jsx';/);
});

test('SearchToggles exports GameIcon and falls back when a game has no SVG', () => {
  assert.match(toggles, /export function GameIcon\(props\)/);
  // The mask branch only runs on a real src, so an empty url() is never emitted.
  assert.match(toggles, /<Show when=\{gameIconSrc\(props\.game\)\} fallback=/);
  assert.match(toggles, /class="game-icon game-icon-fallback"/);
  assert.match(toggles, /class="game-icon" style=/);
  // The picker that already used it keeps using it.
  assert.match(toggles, /<GameIcon game=\{current\(\)\} \/>/);
});

test('the hover card lays a game row out side by side', () => {
  assert.match(
    rule(styles, '\\.nav-preview \\.nav-game \\{'),
    /flex-direction: row;[^}]*align-items: center;[^}]*gap: 0\.6rem;/s,
  );
  // Fixed square either way, so the rows do not shift when the mask loads.
  const icon = rule(styles, '\\.nav-preview \\.nav-game \\.game-icon');
  assert.match(icon, /width: 1\.2rem;/);
  assert.match(icon, /height: 1\.2rem;/);
  assert.match(icon, /color: inherit;/);
});

test('the hover card name keeps the look it had as bare link text', () => {
  const name = rule(styles, '\\.nav-preview li \\.nav-game-name');
  for (const prop of ['color', 'font-size', 'font-weight', 'line-height']) {
    assert.match(name, new RegExp(`${prop}: inherit;`));
  }
  assert.match(name, /white-space: nowrap;/);
});

test('the fallback ring is styled once for both pickers', () => {
  const fallback = rule(searchBox, '\\.game-icon-fallback');
  assert.match(fallback, /mask-image: none;/);
  assert.match(fallback, /background: none;/);
  assert.match(fallback, /border: 1\.5px solid currentColor;/);
  assert.match(fallback, /border-radius: 50%;/);
  assert.match(fallback, /display: grid;[^}]*place-items: center;/s);
});
