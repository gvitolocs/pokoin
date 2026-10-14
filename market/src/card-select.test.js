import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyCardSelect, bandHits, cardsForDragFromCatalog, selectionFromBand } from './card-select.js';
import { cardsReference, dragCardsOf } from './chat-listing.js';

const root = path.dirname(fileURLToPath(import.meta.url));

test('ctrl toggles, shift fills the range, ctrl-shift adds another range', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const first = applyCardSelect({ selected: new Set(), anchor: '' }, ids, 'b', { ctrl: true });
  assert.deepEqual([...first.selected], ['b']);
  const range = applyCardSelect(first, ids, 'd', { shift: true });
  assert.deepEqual([...range.selected], ['b', 'c', 'd']);
  const extra = applyCardSelect(range, ids, 'a', { ctrl: true, shift: true });
  assert.deepEqual([...extra.selected], ['b', 'c', 'd', 'a']);
  const off = applyCardSelect(extra, ids, 'c', { ctrl: true });
  assert.equal(off.selected.has('c'), false);
});

test('a drag box selects the tiles it touches', () => {
  const rects = [
    { id: '1', left: 0, right: 40, top: 0, bottom: 60 },
    { id: '2', left: 50, right: 90, top: 0, bottom: 60 },
    { id: '3', left: 0, right: 40, top: 80, bottom: 140 },
  ];
  assert.deepEqual(bandHits(rects, { x0: 10, y0: 10, x1: 12, y1: 12 }), []);
  assert.deepEqual(bandHits(rects, { x0: 30, y0: 10, x1: 70, y1: 20 }), ['1', '2']);
  const added = selectionFromBand(new Set(['3']), ['1'], { ctrl: true });
  assert.deepEqual([...added], ['3', '1']);
  assert.deepEqual([...selectionFromBand(new Set(['3']), ['2'], { ctrl: false })], ['2']);
});

test('a selected group drags as cards and one card stays a single reference', () => {
  const held = { id: '10', name: 'Drifblim' };
  const group = cardsReference([
    held,
    { id: '9', name: 'Drifloon', canonicalPath: '/marketplace/en/cards/9' },
  ]);
  assert.equal(group.kind, 'cards');
  assert.equal(group.cardName, '2 cards');
  assert.equal(dragCardsOf(group).length, 2);
  assert.equal(dragCardsOf(group)[0].cardId, '10');
  const one = cardsReference([{ id: '9', name: 'Drifloon' }]);
  assert.equal(one.kind, 'card');
  assert.equal(dragCardsOf(one).length, 1);
});

test('the held card leads the multi-select drag pile', () => {
  const lib = fs.readFileSync(path.join(root, 'card-select.js'), 'utf8');
  assert.match(lib, /\[head, \.\.\.rest\]/);
});

test('drag pile spans every registered rail, not only the held card\'s grid', () => {
  const catalog = new Map([
    ['1', { id: '1', name: 'Recent A' }],
    ['2', { id: '2', name: 'Recent B' }],
    ['3', { id: '3', name: 'New A' }],
    ['4', { id: '4', name: 'New B' }],
  ]);
  const selected = new Set(['1', '2', '3', '4']);
  const pile = cardsForDragFromCatalog({ id: '3', name: 'New A' }, selected, catalog);
  assert.equal(pile.length, 4);
  assert.equal(pile[0].id, '3');
  assert.deepEqual(pile.slice(1).map((row) => row.id).sort(), ['1', '2', '4']);
});

// The UI side (select band host, desk frame, grids, shop list) is guarded in
// solid/src/components/card-select.test.js.
test('empty-background bands may start over the desk art-frame and shop panel', () => {
  const marquee = fs.readFileSync(path.join(root, 'shop-marquee.js'), 'utf8');
  assert.match(marquee, /\.art-frame/);
  assert.match(marquee, /\.shop-panel/);
});
test('drag pile CSS styles canvas layers like the old img pile', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.drag-stack img,\s*\.drag-stack canvas\s*\{/);
  assert.match(css, /\.drag-stack canvas[\s\S]*?position:\s*fixed/);
});
