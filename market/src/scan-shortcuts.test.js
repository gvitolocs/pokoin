import assert from 'node:assert/strict';
import test from 'node:test';
import { CONDITION_KEYS, HELP_SECTIONS, LANGUAGE_KEYS, isEditableTarget, shortcutFor } from './scan-shortcuts.js';

const div = { tagName: 'DIV' };
function key(k, extra = {}) {
  const code = extra.code
    || (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k === '[' ? 'BracketLeft' : k === ']' ? 'BracketRight' : '');
  return { key: k, code, target: div, ...extra };
}

test('PowerTools Pokémon hotkeys (verified map) drive the focused row', () => {
  // module ./Pokemon_hotkeys.json in candyext/dump main.1fff971d.chunk.js
  const verified = {
    q: ['condition', 'NM'], w: ['condition', 'NM'], e: ['condition', 'SP'], r: ['condition', 'MP'],
    t: ['condition', 'MP'], y: ['condition', 'PL'], u: ['condition', 'Poor'],
    a: ['language', 'EN'], s: ['language', 'ES'], d: ['language', 'DE'], f: ['language', 'FR'],
    g: ['language', 'IT'], h: ['language', 'RU'], j: ['language', 'JP'], k: ['language', 'KO'],
    l: ['language', 'PT'], m: ['language', 'ZHT'], n: ['language', 'NL'], p: ['language', 'PL'],
    ']': ['language', 'ZH'], z: ['language', 'ID'], x: ['language', 'TH'],
  };
  for (const [k, [field, value]] of Object.entries(verified)) {
    assert.deepEqual(shortcutFor(key(k)), { command: 'set', field, value, target: 'row' }, k);
  }
  assert.deepEqual(shortcutFor(key('i')), { command: 'toggle', field: 'reverse', target: 'row' });
  assert.deepEqual(shortcutFor(key('o')), { command: 'toggle', field: 'firstEdition', target: 'row' });
  assert.deepEqual(shortcutFor(key('[')), { command: 'toggle', field: 'signed', target: 'row' });
  assert.equal(Object.keys(CONDITION_KEYS).length, 7);
  assert.equal(Object.keys(LANGUAGE_KEYS).length, 15);
});

test('PowerTools action keys: Enter/Space confirm, c copy, Delete remove, v/b move', () => {
  assert.deepEqual(shortcutFor(key('Enter')), { command: 'confirm' });
  assert.deepEqual(shortcutFor(key(' ', { code: 'Space' })), { command: 'confirm' });
  assert.deepEqual(shortcutFor(key('c')), { command: 'duplicate' });
  assert.deepEqual(shortcutFor(key('Delete')), { command: 'remove' });
  assert.deepEqual(shortcutFor(key('v')), { command: 'move', delta: -1 });
  assert.deepEqual(shortcutFor(key('b')), { command: 'move', delta: 1 });
  // Esc never deletes on the scan desk.
  assert.deepEqual(shortcutFor(key('Escape')), { command: 'cancel' });
});

test('Shift + a row key targets the Batch Defaults, using the physical key', () => {
  assert.deepEqual(shortcutFor(key('G', { shiftKey: true, code: 'KeyG' })), { command: 'set', field: 'language', value: 'IT', target: 'defaults' });
  assert.deepEqual(shortcutFor(key('W', { shiftKey: true, code: 'KeyW' })), { command: 'set', field: 'condition', value: 'NM', target: 'defaults' });
  assert.deepEqual(shortcutFor(key('{', { shiftKey: true, code: 'BracketLeft' })), { command: 'toggle', field: 'signed', target: 'defaults' });
  assert.deepEqual(shortcutFor(key('>', { shiftKey: true, code: 'Period' })), null);
});

test('Pokoin gap keys', () => {
  assert.deepEqual(shortcutFor(key('ArrowDown')), { command: 'move', delta: 1 });
  assert.deepEqual(shortcutFor(key('ArrowUp')), { command: 'move', delta: -1 });
  assert.deepEqual(shortcutFor(key('ArrowRight')), { command: 'candidate', delta: 1 });
  assert.deepEqual(shortcutFor(key('ArrowLeft')), { command: 'candidate', delta: -1 });
  assert.deepEqual(shortcutFor(key('ArrowDown', { altKey: true, code: 'ArrowDown' })), { command: 'nextAttention' });
  // macOS Alt+3 types '£'; the physical code still picks candidate 3.
  assert.deepEqual(shortcutFor(key('£', { altKey: true, code: 'Digit3' })), { command: 'pickCandidate', index: 2 });
  assert.deepEqual(shortcutFor(key('¬', { altKey: true, code: 'KeyL' })), { command: 'focusDefault', field: 'location' });
  assert.deepEqual(shortcutFor(key('œ', { altKey: true, code: 'KeyQ' })), { command: 'focusDefault', field: 'quantity' });
  assert.deepEqual(shortcutFor(key('π', { altKey: true, code: 'KeyP' })), { command: 'pause' });
  assert.deepEqual(shortcutFor(key('.', { code: 'Period' })), { command: 'cycleFinish', target: 'row' });
  assert.deepEqual(shortcutFor(key('/', { code: 'Slash' })), { command: 'replace' });
  assert.deepEqual(shortcutFor(key('?', { shiftKey: true, code: 'Slash' })), { command: 'help' });
  assert.deepEqual(shortcutFor(key('4')), { command: 'qtyDigit', digit: '4' });
  assert.deepEqual(shortcutFor(key('=', { code: 'Equal' })), { command: 'qtyStep', delta: 1 });
  assert.deepEqual(shortcutFor(key('+', { shiftKey: true, code: 'Equal' })), { command: 'qtyStep', delta: 1 });
  assert.deepEqual(shortcutFor(key('-', { code: 'Minus' })), { command: 'qtyStep', delta: -1 });
  assert.deepEqual(shortcutFor(key('Backspace')), { command: 'qtyBackspace' });
  assert.deepEqual(shortcutFor(key('z', { metaKey: true })), { command: 'undo' });
  assert.deepEqual(shortcutFor(key('z', { ctrlKey: true, shiftKey: true })), { command: 'redo' });
  assert.deepEqual(shortcutFor(key('Enter', { metaKey: true })), { command: 'submit' });
});

test('never steals keys from text fields', () => {
  const input = { tagName: 'INPUT', type: 'text' };
  const number = { tagName: 'INPUT', type: 'number' };
  const textarea = { tagName: 'TEXTAREA' };
  const select = { tagName: 'SELECT' };
  const editable = { tagName: 'DIV', isContentEditable: true };
  for (const target of [input, number, textarea, select, editable]) {
    assert.equal(isEditableTarget(target), true);
    for (const k of ['a', 'q', 'i', '1', 'Enter', ' ', 'Delete', 'Backspace', 'c', 'v', '/', 'ArrowDown']) {
      assert.equal(shortcutFor(key(k, { target })), null, `${k} in ${target.tagName}`);
    }
    assert.equal(shortcutFor(key('z', { metaKey: true, target })), null, 'field keeps its own undo');
    assert.deepEqual(shortcutFor(key('Enter', { metaKey: true, target })), { command: 'submit' });
    assert.deepEqual(shortcutFor(key('Escape', { target })), { command: 'cancel' });
  }
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
});

test('browser shortcuts, IME composition, auto-repeat toggles and open dialogs are left alone', () => {
  assert.equal(shortcutFor(key('c', { metaKey: true })), null, 'copy');
  assert.equal(shortcutFor(key('r', { ctrlKey: true })), null, 'reload');
  assert.equal(shortcutFor(key('a', { isComposing: true })), null);
  assert.equal(shortcutFor(key('i', { repeat: true })), null);
  assert.equal(shortcutFor(key('Delete', { repeat: true })), null);
  assert.deepEqual(shortcutFor(key('ArrowDown', { repeat: true })), { command: 'move', delta: 1 });
  assert.equal(shortcutFor(key('a', { defaultPrevented: true })), null);
  assert.equal(shortcutFor(key('a'), { modalOpen: true }), null);
  assert.deepEqual(shortcutFor(key('Escape'), { modalOpen: true }), { command: 'cancel' });
  assert.equal(shortcutFor(key('a'), { helpOpen: true }), null);
  assert.deepEqual(shortcutFor(key('?', { shiftKey: true }), { helpOpen: true }), { command: 'help' });
});

test('help overlay lists every PowerTools key the map binds', () => {
  const text = JSON.stringify(HELP_SECTIONS);
  for (const k of [...Object.keys(CONDITION_KEYS), ...Object.keys(LANGUAGE_KEYS), 'i', 'o', '[', 'c', 'Delete', 'v / b', '?']) {
    assert.ok(text.includes(k), k);
  }
});
