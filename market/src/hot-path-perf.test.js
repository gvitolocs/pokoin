import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPknNumber } from './pkn.js';
import { compactQuery } from './compact-query.js';
import { NAME_POOL } from './suggest-rank.js';
import { bindRailControls } from './rail-scroll.js';
import { flushHomeVectorCacheWrites, scheduleHomeVectorCacheWrite } from './home-cache.js';

// Verbatim copy of the pre-optimisation call (2026-10-09) — the oracle.
function refPknNumber(value, d) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '0';
  }
  return amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: d });
}

test('formatPknNumber (cached formatter) equals toLocaleString byte for byte', () => {
  const digits = [0, 2, 4];
  const values = [
    0, -0, 1, 2642, 2642.5, 0.005, 1234567.891, -42.125, 1e21, 123456789012, 0.1 + 0.2,
  ];
  for (const d of digits) {
    for (const value of values) {
      assert.equal(formatPknNumber(value, { maximumFractionDigits: d }), refPknNumber(value, d), `${value} @${d}`);
    }
  }
  for (const bad of [NaN, Infinity, 'abc', undefined]) {
    assert.equal(formatPknNumber(bad), '0', String(bad));
    assert.equal(formatPknNumber(bad, { maximumFractionDigits: 4 }), '0', String(bad));
  }
});

// Verbatim copy of the full pipeline from compact-query.js — the oracle.
function fullCompact(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[δΔ]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('compactQuery ASCII fast path equals the full pipeline', () => {
  const samples = [];
  for (let code = 0; code <= 127; code += 1) {
    samples.push(String.fromCharCode(code));
  }
  const rng = mulberry32(23);
  for (let i = 0; i < 20000; i += 1) {
    const len = Math.floor(rng() * 25);
    let text = '';
    for (let j = 0; j < len; j += 1) {
      text += String.fromCharCode(Math.floor(rng() * 128));
    }
    samples.push(text);
  }
  for (const row of NAME_POOL) {
    samples.push(row.display);
  }
  for (const sample of samples) {
    assert.equal(compactQuery(sample), fullCompact(sample), JSON.stringify(sample));
  }
  for (const sample of [
    'Pokémon', 'Flabébé', 'ピカチュウ', 'Pikachu δ Delta Species', 'ＡＢＣ', 'Pokémon',
  ]) {
    assert.equal(compactQuery(sample), fullCompact(sample), sample);
  }
});

test('bindRailControls leaves the first sync to the ResizeObserver when one exists', () => {
  const fakeObserver = globalThis.ResizeObserver;
  try {
    const node = {
      reads: 0,
      scrollLeft: 0,
      scrollWidth: 1000,
      clientWidth: 400,
      parentElement: null,
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(node, 'scrollLeft', { get() { node.reads += 1; return 0; } });
    // syncRailControls needs a wrap before it reaches the scroll geometry.
    node.parentElement = { querySelector: () => null };

    delete globalThis.ResizeObserver;
    const cleanupNoObserver = bindRailControls(node);
    assert.ok(node.reads > 0, 'no ResizeObserver: initial sync runs synchronously');
    cleanupNoObserver();

    node.reads = 0;
    let callback = null;
    globalThis.ResizeObserver = class FakeResizeObserver {
      constructor(cb) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    };
    const cleanupObserver = bindRailControls(node);
    assert.equal(node.reads, 0, 'ResizeObserver available: no synchronous layout read');
    assert.ok(callback, 'observer callback captured');
    callback();
    assert.ok(node.reads > 0, 'the observer callback performs the initial sync');
    cleanupObserver();
  } finally {
    if (fakeObserver === undefined) {
      delete globalThis.ResizeObserver;
    } else {
      globalThis.ResizeObserver = fakeObserver;
    }
  }
});

test('scheduleHomeVectorCacheWrite keeps only the latest payload per game', () => {
  const savedWindow = globalThis.window;
  const savedIdle = globalThis.requestIdleCallback;
  const savedAddEventListener = globalThis.addEventListener;
  const savedDocument = globalThis.document;
  try {
    globalThis.window = {
      addEventListener: () => {},
      requestIdleCallback: () => 1,
      setTimeout: () => 2,
    };
    globalThis.requestIdleCallback = () => 1;
    globalThis.addEventListener = () => {};
    globalThis.document = { visibilityState: 'visible' };

    const calls = [];
    const store = {
      getItem() {
        return null;
      },
      setItem(key, value) {
        calls.push({ key, value });
      },
      removeItem(key) {
        calls.push({ key });
      },
    };
    const first = { game: 'pokemon', cards: [{ id: '1', name: 'A' }], sections: { newArrivalIds: ['1'] } };
    const second = { game: 'pokemon', cards: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }], sections: { newArrivalIds: ['1', '2'] } };

    scheduleHomeVectorCacheWrite('pokemon', first, store);
    scheduleHomeVectorCacheWrite('pokemon', second, store);
    assert.equal(calls.length, 0, 'nothing written before the flush');

    flushHomeVectorCacheWrites();
    assert.equal(calls.length, 1);
    const written = JSON.parse(calls[0].value);
    assert.deepEqual(written.payload.cards, second.cards);
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedIdle === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = savedIdle;
    if (savedAddEventListener === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = savedAddEventListener;
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});
