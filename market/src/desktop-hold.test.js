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
  setDesktopQty,
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
  ]), 3);
  assert.equal(readDesktopHold().length, 2);
  assert.equal(readDesktopHold().find((row) => row.id === '1').qty, 2);
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
      set: 'Alpha',
      number: '12/99',
      rarity: 'Elite',
      artist: 'Nez',
      price: 42,
      era: 'Alpha',
    }),
    {
      id: '825230',
      name: 'Aria Wraith',
      collectorNumber: '12/99',
      expansion: 'Alpha',
      era: 'Alpha',
      artist: 'Nez',
      rarity: 'Elite',
      pricePkn: 42,
      qty: 1,
      stock: 99,
      imageUrl: '/card-images/sorcery/x_homepage.webp',
      path: '/marketplace/en/cards/825230',
    },
  );
});

test('desktopHoldCard rewrites CardTrader preview_ to leftover homepage', () => {
  const row = desktopHoldCard({
    id: '813554',
    name: 'Eevee',
    expansion: '30th Celebration',
    number: '116/128',
    imageUrl: 'https://cardtrader.com/uploads/blueprints/image/406777/preview_406777-eevee-116-128-30th-celebration.webp',
    canonicalPath: '/marketplace/en/cards/813554/card-eevee-116-128-30th-celebration',
  });
  assert.match(row.imageUrl, /\/card-images\/406777_eevee_homepage\.webp/);
  assert.match(row.imageUrl, /\?v=wj1/);
  assert.equal(row.era, 'Mega Evolution');
});

test('readDesktopHold rewrites parked CardTrader preview_ URLs', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  clearDesktopHold();
  store.set('pokoin.desktopHold', JSON.stringify([{
    id: '813554',
    name: 'Eevee',
    expansion: '30th Celebration',
    era: '',
    imageUrl: 'https://cardtrader.com/uploads/blueprints/image/406777/preview_406777-eevee.webp',
    path: '/marketplace/en/cards/813554/card-eevee-116-128-30th-celebration',
  }]));
  const rows = readDesktopHold();
  assert.equal(rows.length, 1);
  assert.match(rows[0].imageUrl, /\/card-images\/406777_eevee_homepage\.webp/);
  assert.match(rows[0].imageUrl, /\?v=wj1/);
});

test('desktopHoldCard derives Mega Evolution era from expansion/setName aliases', () => {
  assert.equal(
    desktopHoldCard({
      id: '813554',
      name: 'Eevee',
      expansion: '30th Celebration',
      number: '116/128',
      artist: 'Wintr Wandr',
    }).era,
    'Mega Evolution',
  );
  assert.equal(
    desktopHoldCard({
      id: '2',
      name: 'Hakamo-o',
      setName: '30th Celebration JP',
      collectorNumber: '090/103',
    }).era,
    'Mega Evolution',
  );
});

test('desktopHoldCsv lists parked cards', () => {
  assert.equal(
    desktopHoldCsv([
      {
        id: '1',
        name: 'A, rare',
        collectorNumber: '1/10',
        expansion: 'Base',
        era: 'Original',
        artist: 'Ken',
        rarity: 'Holo',
        pricePkn: 18,
      },
      {
        id: '2',
        name: 'B',
        collectorNumber: '',
        expansion: '',
        era: '',
        artist: '',
        rarity: '',
        pricePkn: '',
      },
    ]),
    'name,collector_number,expansion,era,artist,rarity,price_pkn\n"A, rare",1/10,Base,Original,Ken,Holo,18\nB,,,,,,\n',
  );
});

test('desktopHoldCsv backfills blank era from expansion', () => {
  assert.equal(
    desktopHoldCsv([
      {
        id: '813554',
        name: 'Eevee',
        collectorNumber: '116/128',
        expansion: '30th Celebration',
        era: '',
        artist: 'Wintr Wandr',
        rarity: '',
        pricePkn: 24,
      },
    ]),
    'name,collector_number,expansion,era,artist,rarity,price_pkn\nEevee,116/128,30th Celebration,Mega Evolution,Wintr Wandr,,24\n',
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

test('Chrome mounts Desktop on the left, opposite the cart', () => {
  const chrome = fs.readFileSync(path.join(root, 'components/Chrome.jsx'), 'utf8');
  const drop = fs.readFileSync(path.join(root, 'components/DesktopDrop.jsx'), 'utf8');
  const cart = fs.readFileSync(path.join(root, 'components/CartDrop.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(chrome, /import DesktopDrop from '\.\/DesktopDrop\.jsx'/);
  assert.match(chrome, /navPop === 'desktop'/);
  const brandAt = chrome.indexOf('className="brand"');
  const desktopAt = chrome.indexOf('className="desktop-anchor"');
  const searchAt = chrome.indexOf('className="search"');
  const cartAt = chrome.indexOf('className="cart-anchor"');
  const iconNavAt = chrome.indexOf('className="nav icon-nav"');
  assert.ok(brandAt > 0 && desktopAt > brandAt && searchAt > desktopAt);
  assert.ok(iconNavAt > searchAt && cartAt > iconNavAt);
  assert.match(css, /\.desktop-drop\s*\{[^}]*left:\s*0/s);
  assert.match(css, /\.desktop-drop\s*\{[^}]*width:\s*min\(26rem/s);
  assert.doesNotMatch(css, /\.desktop-drop\s*\{[^}]*right:\s*0/s);
  assert.match(css, /\.desktop-drop-actions\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(css, /\.cart-drop-card \.chat-qty/);
  assert.match(drop, /Clear desktop/);
  assert.match(drop, /Add to cart/);
  assert.match(drop, /Export PDF/);
  assert.match(drop, /downloadDesktopHoldPdf/);
  assert.match(drop, /desktop-drop-x/);
  assert.match(drop, /QtyStepper/);
  assert.match(drop, /setDesktopQty/);
  assert.match(cart, /QtyStepper/);
  assert.match(drop, /Draw the shape of your next collection/);
  assert.doesNotMatch(drop, /Drop cards you are unsure about/);
  assert.doesNotMatch(drop, /downloadDesktopHoldCsv/);
});

test('Desktop hold merges qty and setDesktopQty caps at stock', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  clearDesktopHold();
  assert.equal(addDesktopCards([{ id: '7', name: 'Magnemite', qty: 2, stock: 2 }]), 1);
  assert.equal(readDesktopHold()[0].qty, 2);
  assert.equal(addDesktopCards([{ id: '7', name: 'Magnemite', qty: 1, stock: 2 }]), 0);
  assert.equal(readDesktopHold()[0].qty, 2, 'cannot exceed stock');
  setDesktopQty('7', 1);
  assert.equal(readDesktopHold()[0].qty, 1);
  setDesktopQty('7', 0);
  assert.equal(readDesktopHold().length, 0);
});
