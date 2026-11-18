import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const drawer = fs.readFileSync(new URL('./ListingEditDrawer.jsx', import.meta.url), 'utf8');
const form = fs.readFileSync(new URL('../desk/ListingForm.jsx', import.meta.url), 'utf8');
const board = fs.readFileSync(new URL('./InventoryBoard.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../../../market/src/desk.css', import.meta.url), 'utf8');

/**
 * The row editor is a drawer, not a centred modal, and it is the desk's own
 * form: `ListingForm` with `variant="drawer"` — one component, one set of
 * signals, one submit. These lines hold that apart.
 */

test('the drawer is a dialog with the desk form inside it', () => {
  for (const line of [
    'role="dialog"',
    'aria-modal="true"',
    'aria-labelledby="listing-drawer-title"',
    'id="listing-drawer-title"',
    'class="listing-drawer-close"',
    'aria-label="Close"',
  ]) assert.ok(drawer.includes(line), line);
  // One way out: the X and Escape both go through onClose, which is the shared helper's job.
  assert.match(drawer, /import \{ useDialogFocus \} from '\.\.\/\.\.\/lib\/dialog-focus\.js';/);
  assert.equal(drawer.match(/onClose: \(\) => props\.onClose\(\)/g).length, 1, 'one close path');
  assert.match(drawer, /variant="drawer"/);
  assert.doesNotMatch(drawer, /ZeroDialog/, 'the centred modal shell is gone');
});

test('the drawer shows the sync note, then the desk form', () => {
  assert.match(drawer, /'Changes go to CardTrader too\.'/);
  assert.match(drawer, /'Card Rails picks up the change on its next sync\.'/);
  const note = drawer.indexOf('listing-drawer-note');
  const fields = drawer.indexOf('<ListingForm');
  assert.ok(note !== -1 && note < fields, 'the note is the first line of the body');
});

test('the board switches the one drawer and asks before discarding', () => {
  assert.match(board, /import ListingEditDrawer from '\.\/ListingEditDrawer\.jsx';/);
  assert.doesNotMatch(board, /ListingEditDialog/, 'no second editor');
  assert.match(board, /pricing=\{props\.pricing\}/);
  assert.match(board, /onDirty=\{setEditDirty\}/);
  assert.match(board, /Discard your changes to \$\{rowName\(current\)\}\?/);
  assert.equal(board.match(/onEdit=\{openEditRow\}/g).length, 4, 'every row opens the same drawer');
  assert.doesNotMatch(board, /onEdit=\{setEditRow\}/, 'nothing opens a drawer over unsaved edits');
});

test('one form: the drawer variant shares price, quotes, graded and photos markup', () => {
  // The fields exist once; both layouts call the same builders.
  for (const name of ['priceField', 'quotesRow', 'gradedRow', 'photosRow', 'messages']) {
    assert.equal(form.match(new RegExp(`function ${name}\\(`, 'g')).length, 1, `${name} is defined once`);
    assert.ok(form.includes(`{${name}()}`), `${name} renders in the drawer too`);
  }
  assert.equal(form.match(/const \[price, setPrice\]/g).length, 1, 'one price signal');
  assert.equal(form.match(/async function submit\(/g).length, 1, 'one save');
  assert.equal(form.match(/props\.onListed\?\.\(/g).length >= 4, true);
});

test('the drawer body is the fields, then the strategy step, then the footer', () => {
  const body = form.slice(form.indexOf('function drawerBody()'), form.indexOf('return (\n    <Show\n      when={!collapsed()}'));
  for (const line of [
    'sell-drawer-fields',
    'sell-pricing',
    'sell-drawer-step',
    'sell-drawer-foot',
    'Save changes',
    'aria-label="Delete listing"',
  ]) assert.ok(body.includes(line), line);
  // Only the row editor makes the price field read-only while a rule owns it.
  assert.match(form, /readOnly=\{drawer\(\) && Boolean\(pricingPick\(\)\)\}/);
  // The desk keeps its own markup: the drawer branch cannot leak into it.
  assert.match(form, /\{drawer\(\) \? drawerBody\(\) : \(/);
});

test('the desk.css styles the drawer and has no centred modal left', () => {
  for (const rule of [
    '.listing-drawer-scrim',
    '.listing-drawer {',
    '.listing-drawer-close',
    '.sell-form.is-drawer',
    '.sell-drawer-fields',
    '.sell-drawer-foot',
    '.sell-pricing-btn',
    '.sell-pricing-list',
    '.sell-price-eq',
    '.chat-qty-input',
  ]) assert.ok(css.includes(rule), rule);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.listing-drawer \{[\s\S]*?border-radius: 18px 18px 0 0/);
  assert.match(css, /\.listing-drawer::before/, 'the grab bar');
  assert.doesNotMatch(css, /\.modal-card\.zero-dialog:has\(\.sell-form\)/, 'the modal is not kept as well');
  assert.doesNotMatch(css, /\.zero-dialog \.sell-form/);
});
