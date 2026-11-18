import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const board = fs.readFileSync(new URL('./InventoryBoard.jsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../../pages/Inventory.jsx', import.meta.url), 'utf8');

/** The source between two markers, so a rule is checked where it is used. */
function slice(text, from, to) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, from);
  const end = text.indexOf(to, start + from.length);
  assert.notEqual(end, -1, to);
  return text.slice(start, end);
}

/** Every `<a …>` body, anchors included: a button inside one is unreachable. */
function anchorBodies(text, open) {
  const out = [];
  let at = text.indexOf(open);
  while (at !== -1) {
    const close = text.indexOf('</a>', at);
    assert.notEqual(close, -1, `${open} is closed`);
    out.push(text.slice(at, close));
    at = text.indexOf(open, close);
  }
  assert.ok(out.length, open);
  return out;
}

test('every row mode ends its link with the two action buttons', () => {
  assert.match(board, /aria-label=\{`Edit \$\{name\(\)\}`\}/);
  assert.match(board, /aria-label=\{`Delete \$\{name\(\)\}`\}/);
  // Table, Stacks, Titles and Grid.
  assert.equal(board.split('<RowActions').length - 1, 4);
  assert.match(board, /<a class="inv-row-link" href=\{inventoryListingHref\(row\)\}>\{cells\}<\/a>\s*<RowActions/);
  const stacks = slice(board, "<Match when={mode() === 'stacks'}>", "<Match when={mode() === 'titles'}>");
  const titles = slice(board, "<Match when={mode() === 'titles'}>", "<Match when={mode() === 'grid'}>");
  const grid = slice(board, "<Match when={mode() === 'grid'}>", '<Match when={true}>');
  for (const mode of [stacks, titles, grid]) assert.match(mode, /<RowActions/);
});

test('the actions sit beside the links, never inside them', () => {
  // A button in an anchor is unclickable and unreachable by keyboard.
  assert.match(board, /<span class=\{\['inv-actions'/);
  assert.doesNotMatch(slice(board, 'const cells = (', 'return ('), /<button/);
  for (const anchor of anchorBodies(board, '<a class="loc-posting"')) assert.doesNotMatch(anchor, /<button/);
  for (const anchor of anchorBodies(board, '<a class="collection-tile"')) assert.doesNotMatch(anchor, /<button/);
  assert.match(board, /<div class="loc-posting-line" data-listing-id=\{rowId\(row\)\}>[\s\S]*?<\/a>\s*<RowActions/);
  assert.match(board, /<div class="inv-tile" data-listing-id=\{rowId\(row\)\}>[\s\S]*?\/>\s*<RowActions/);
});

test('one row asks once, unlists and never reloads the book', () => {
  assert.match(board, /window\.confirm\(`Remove \$\{name\} from your shop\?\$\{extra\}`\)/);
  assert.match(board, /cardtraderLinked\(row\) \? ' It is also taken off CardTrader\.'/);
  assert.match(board, /await cancelListing\(id, token, authUser\(\)\?\.uid \|\| authSession\(\)\?\.uid \|\| ''\)/);
  assert.match(board, /props\.onRowRemoved\?\.\(id\)/);
  assert.match(board, /props\.onRowSaved\?\.\(saved\)/);
  assert.match(board, /queueMicrotask\(\(\) => focusRowEdit\(rowId\(saved\)\)\)/);
  assert.match(board, /queueMicrotask\(\(\) => focusRowEdit\(rowId\(neighbour\)\)\)/);
  assert.match(board, /querySelector\('\.inv-edit'\)/);
  assert.doesNotMatch(board, /reload\(\)/);
});

test('the page writes the answered row into the book in place', () => {
  assert.match(page, /onRowSaved=\{\(saved\) => paintRows\(applyEditedRow\(rows\(\), saved\)\)\}/);
  assert.match(page, /onRowRemoved=\{\(id\) => paintRows\(removeListingRow\(rows\(\), id\)\)\}/);
  assert.match(page, /function paintRows\(next\) \{\n\s*setRows\(next\);\n\s*const book = inventoryBooks\.peek\(listingsUid\(\), selectedGame\);\n\s*if \(book\) book\.rows = next;/);
  // An edit or an unlist is already on the server: no whole-book read after it.
  assert.doesNotMatch(page, /onRow(?:Saved|Removed)=[^\n]*reload\(\)/);
});
