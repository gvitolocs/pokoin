import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyCardSelect, bandHits, selectionFromBand } from './card-select.js';
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
  const group = cardsReference([
    { id: '9', name: 'Drifloon', canonicalPath: '/marketplace/en/cards/9' },
    { id: '10', name: 'Drifblim' },
  ]);
  assert.equal(group.kind, 'cards');
  assert.equal(group.cardName, '2 cards');
  assert.equal(dragCardsOf(group).length, 2);
  assert.equal(dragCardsOf(group)[0].cardId, '9');
  const one = cardsReference([{ id: '9', name: 'Drifloon' }]);
  assert.equal(one.kind, 'card');
  assert.equal(dragCardsOf(one).length, 1);
});

test('every browsing card grid can select tiles', () => {
  const pages = [
    'pages/Home.jsx',
    'pages/Search.jsx',
    'pages/Expansion.jsx',
    'pages/Artist.jsx',
    'pages/Products.jsx',
    'pages/Watchlist.jsx',
    'pages/PokemonHub.jsx',
    'pages/RarityHub.jsx',
    'pages/Versions.jsx',
    'components/RelatedCards.jsx',
    'components/Carousel.jsx',
  ];
  for (const file of pages) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /CardSelectGrid/, file);
  }
  const tile = fs.readFileSync(path.join(root, 'components/CardTile.jsx'), 'utf8');
  assert.match(tile, /is-selected/);
  assert.match(tile, /cardsForDrag/);
});
