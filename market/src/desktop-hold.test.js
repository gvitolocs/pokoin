import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addDesktopCards,
  clearDesktopHold,
  desktopHoldCard,
  desktopHoldCsv,
  readDesktopHold,
  removeDesktopCard,
} from './desktop-hold.js';

const root = path.dirname(fileURLToPath(import.meta.url));

test('desktop hold keeps unique cards and clears', () => {
  const store = new Map();
  const memory = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  globalThis.localStorage = memory;
  clearDesktopHold();
  assert.equal(addDesktopCards([
    { id: '1', name: 'A', imageUrl: '/a.jpg' },
    { id: '1', name: 'A again' },
    { id: '2', name: 'B', imageUrl: '/b.jpg' },
  ]), 2);
  assert.equal(readDesktopHold().length, 2);
  removeDesktopCard('1');
  assert.deepEqual(readDesktopHold().map((row) => row.id), ['2']);
  clearDesktopHold();
  assert.equal(readDesktopHold().length, 0);
});

test('desktopHoldCard shapes a catalog row', () => {
  assert.deepEqual(
    desktopHoldCard({
      card_id: '825230',
      name: 'Aria Wraith',
      imageUrl: '/card-images/sorcery/x.jpg',
      canonicalPath: '/marketplace/en/cards/825230',
    }),
    {
      id: '825230',
      name: 'Aria Wraith',
      imageUrl: '/card-images/sorcery/x.jpg',
      path: '/marketplace/en/cards/825230',
    },
  );
});

test('desktopHoldCsv lists parked cards', () => {
  assert.equal(
    desktopHoldCsv([
      { id: '1', name: 'A, rare', path: '/a', imageUrl: '/a.jpg' },
      { id: '2', name: 'B', path: '/b', imageUrl: '' },
    ]),
    'card_id,name,path,image_url\n1,"A, rare",/a,/a.jpg\n2,B,/b,\n',
  );
});

test('readDesktopHold returns the same array when storage is unchanged', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  clearDesktopHold();
  addDesktopCards([{ id: '9', name: 'Stable' }]);
  const a = readDesktopHold();
  const b = readDesktopHold();
  assert.equal(a, b);
  assert.equal(a.length, 1);
});

test('Chrome mounts a Desktop tray next to cart', () => {
  const chrome = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
  const drop = fs.readFileSync(path.join(root, 'components/DesktopDrop.jsx'), 'utf8');
  assert.match(chrome, /import DesktopDrop from '\.\/DesktopDrop\.jsx'/);
  assert.match(chrome, /navPop === 'desktop'/);
  assert.match(drop, /Clear desktop/);
  assert.match(drop, /Add to cart/);
  assert.match(drop, /Export/);
  assert.match(drop, /downloadDesktopHoldCsv/);
  assert.match(drop, /desktop-drop-x/);
  assert.match(drop, /<strong>Desktop<\/strong>/);
});
