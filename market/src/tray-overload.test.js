import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CARD_PAGE_STORE_CAP, pruneStoredCardPages, rememberStoredCardPage } from './card-page-cache.js';
import {
  addDesktopCards,
  clearDesktopHold,
  DESKTOP_MAX,
  desktopHoldMemoryOnly,
  readDesktopHold,
} from './desktop-hold.js';
import { buildDesktopPdfPagesBytes, desktopPdfCellOrigin, desktopPdfLayout, desktopPdfPagination } from './desktop-hold-pdf.js';

const root = path.dirname(fileURLToPath(import.meta.url));

/** localStorage with key()/length and an optional byte quota. */
function quotaStorage(quotaChars = Infinity) {
  const store = new Map();
  const used = () => [...store].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
  return {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      const prior = store.get(key);
      store.set(String(key), String(value));
      if (used() > quotaChars) {
        if (prior === undefined) store.delete(key); else store.set(key, prior);
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
    },
    removeItem: (key) => { store.delete(String(key)); },
    keys: () => [...store.keys()],
  };
}

function cardPage(id, savedAt, filler = 500) {
  return { card: { id: String(id), name: `Card ${id}` }, filler: 'x'.repeat(filler), savedAt };
}

test('card-page cache keeps only the newest CARD_PAGE_STORE_CAP pages in localStorage', () => {
  const storage = quotaStorage();
  globalThis.localStorage = storage;
  for (let i = 1; i <= CARD_PAGE_STORE_CAP + 25; i += 1) {
    rememberStoredCardPage(String(i), cardPage(i, 1_000_000 + i));
  }
  const kept = storage.keys().filter((key) => key.startsWith('pokoin.cardPage.v2.'));
  assert.equal(kept.length, CARD_PAGE_STORE_CAP);
  assert.ok(kept.includes(`pokoin.cardPage.v2.pokemon:en:${CARD_PAGE_STORE_CAP + 25}`));
  assert.ok(!kept.includes('pokoin.cardPage.v2.pokemon:en:1'));
  assert.equal(pruneStoredCardPages(0), CARD_PAGE_STORE_CAP);
});

test('a whole artist fits on the Desktop (was capped at 200)', () => {
  globalThis.localStorage = quotaStorage();
  clearDesktopHold();
  const cards = Array.from({ length: 3070 }, (_, i) => ({ id: String(100000 + i), name: `Card ${i}` }));
  assert.equal(addDesktopCards(cards), 3070);
  assert.equal(readDesktopHold().length, 3070);
  assert.ok(DESKTOP_MAX >= 5120, 'room for 5ban Graphics');
  clearDesktopHold();
});

test('a full localStorage clears card-page caches, and never snaps the Desktop back to empty', () => {
  const storage = quotaStorage(60_000);
  globalThis.localStorage = storage;
  clearDesktopHold();
  for (let i = 1; i <= 30; i += 1) {
    storage.setItem(`pokoin.cardPage.v2.pokemon:en:${i}`, JSON.stringify(cardPage(i, i, 1800)));
  }
  // Fits only once the stale card pages are dropped.
  addDesktopCards(Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), name: `Card ${i}` })));
  assert.equal(readDesktopHold().length, 60);
  assert.equal(desktopHoldMemoryOnly(), false);
  assert.equal(storage.keys().filter((key) => key.startsWith('pokoin.cardPage.v2.')).length, 0);
  // Far past the quota: kept in memory for this tab instead of reading back [].
  addDesktopCards(Array.from({ length: 2000 }, (_, i) => ({ id: String(5000 + i), name: `Card ${i}` })));
  assert.equal(desktopHoldMemoryOnly(), true);
  assert.equal(readDesktopHold().length, 2060);
  clearDesktopHold();
  assert.equal(desktopHoldMemoryOnly(), false);
});

test('cart writes never throw on a full localStorage (the black-screen crash)', () => {
  const src = fs.readFileSync(path.join(root, 'cart.jsx'), 'utf8');
  const body = src.slice(src.indexOf('function writeCart'), src.indexOf('export function peekCartItems'));
  assert.match(body, /try \{\s*localStorage\.setItem\(CART_KEY, raw\);\s*\} catch/);
  assert.match(body, /pruneStoredCardPages\(0\)/);
});

test('cart and Desktop trays mount at most TRAY_VISIBLE thumbs and full scans only for a few cards', () => {
  for (const file of ['components/CartDrop.jsx', 'components/DesktopDrop.jsx']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /items\.slice\(0, TRAY_VISIBLE\)/, file);
    assert.match(src, /full=\{fullArt\}/, file);
    assert.doesNotMatch(src, /alt="" (card=\{row\} )?full \/>/, file);
    assert.match(src, /\{shown\.map\(/, file);
  }
  const desktop = fs.readFileSync(path.join(root, 'components/DesktopDrop.jsx'), 'utf8');
  assert.match(desktop, /fetchArtist\(bundle\.slug, \{ limit: DESKTOP_MAX \}\)/);
});

test('cart bundle drops add found cards in one burst, listed printings first', () => {
  const src = fs.readFileSync(path.join(root, 'components/CartDrop.jsx'), 'utf8');
  assert.match(src, /for \(const item of found\) onAdd\(item\);/);
  assert.doesNotMatch(src, /if \(offer\) onAdd\(/);
  const add = fs.readFileSync(path.join(root, 'cart-add.js'), 'utf8');
  assert.match(add, /for \(const item of found\) onAdd\(item\);/);
});

test('Desktop PDF paginates past 80 cards with one card size on every page', () => {
  assert.deepEqual(desktopPdfPagination(80), { pages: 1, perPage: 80 });
  assert.deepEqual(desktopPdfPagination(81), { pages: 2, perPage: 41 });
  assert.deepEqual(desktopPdfPagination(3070), { pages: 39, perPage: 79 });
  const layout = desktopPdfLayout(2);
  const cell = (i) => ({ box: desktopPdfCellOrigin(layout, i), caption: `c${i}`, jpeg: null, pxW: 1, pxH: 1 });
  const bytes = buildDesktopPdfPagesBytes([
    { cells: [cell(0), cell(1)], layout },
    { cells: [cell(0)], layout },
  ]);
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /\/Type \/Pages \/Kids \[\d+ 0 R \d+ 0 R\] \/Count 2/);
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 2);
  assert.match(text, /%%EOF/);
});
