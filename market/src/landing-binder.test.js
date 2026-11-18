import assert from 'node:assert/strict';
import test from 'node:test';
import { LANDING_BINDER_KEY, clearAuthSession, writeAuthSession } from './auth-session.js';
import {
  BINDER_SLOTS,
  MISSING_CARD,
  binderCount,
  binderFill,
  binderPage,
  clearBinderCache,
  readBinderCache,
  samePage,
  writeBinderCache,
} from './landing-binder.js';

function memoryStore() {
  const map = new Map();
  return {
    cookie: '',
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

const image = (row) => ({ src: `https://cdn.pokoin.com/${row.cardId}_x_homepage.webp`, full: `https://cdn.pokoin.com/${row.cardId}_x.jpg` });
const href = (row) => `/marketplace/en/cards/${row.cardId}`;
const rows = (n) => Array.from({ length: n }, (_, i) => ({ cardId: String(1000 + i), cardName: `Card ${i}` }));

test('the binder page is the first nine holdings in answer order, with the whole count', () => {
  const page = binderPage({ uid: 'u1', items: rows(12), itemCount: 40 }, { image, href });
  assert.equal(page.uid, 'u1');
  assert.equal(page.total, 40);
  assert.equal(page.cards.length, BINDER_SLOTS);
  assert.deepEqual(page.cards.map((card) => card.name), rows(9).map((row) => row.cardName));
  assert.equal(page.cards[0].href, '/marketplace/en/cards/1000');
  assert.equal(page.cards[0].src, 'https://cdn.pokoin.com/1000_x_homepage.webp');
  assert.equal(binderCount(page), '9 / 40');
  assert.equal(binderFill(page), '23%');
});

test('a small collection fills only its own slots and counts honestly', () => {
  const page = binderPage({ uid: 'u1', items: rows(4), itemCount: 4 }, { image, href });
  assert.equal(page.cards.length, 4);
  assert.equal(binderCount(page), '4 / 4');
  assert.equal(binderFill(page), '100%');
  // itemCount can never claim fewer than the cards sent.
  assert.equal(binderPage({ uid: 'u1', items: rows(3), itemCount: 1 }, { image, href }).total, 3);
});

test('an empty collection has no cards, and an ownerless answer is no page', () => {
  assert.deepEqual(binderPage({ uid: 'u1', items: [], itemCount: 0 }, { image, href }), { uid: 'u1', total: 0, cards: [] });
  assert.equal(binderPage({ items: rows(3) }, { image, href }), null);
  assert.equal(binderPage(null, { image, href }), null);
});

test('foreign links and pictures never reach the binder', () => {
  const page = binderPage({
    uid: 'u1',
    items: [{ cardId: '1', cardName: 'Evil' }],
  }, {
    image: () => ({ src: 'https://evil.example/x.webp', full: 'javascript:alert(1)' }),
    href: () => 'https://evil.example/cards/1',
  });
  assert.equal(page.cards[0].src, MISSING_CARD);
  assert.equal(page.cards[0].full, '');
  assert.equal(page.cards[0].href, '');
});

test('the stored page is only read back for the uid it belongs to', () => {
  const storage = memoryStore();
  const page = binderPage({ uid: 'alice', items: rows(9), itemCount: 30 }, { image, href });
  writeBinderCache(page, storage);
  assert.deepEqual(readBinderCache('alice', storage), page);
  assert.equal(readBinderCache('bob', storage), null);
  assert.equal(readBinderCache('', storage), null);

  // Bob's page replaces Alice's: one account per browser.
  writeBinderCache(binderPage({ uid: 'bob', items: rows(2), itemCount: 2 }, { image, href }), storage);
  assert.equal(readBinderCache('alice', storage), null);
  assert.equal(readBinderCache('bob', storage).cards.length, 2);

  // Writing an empty page clears; garbage and old versions read as nothing.
  writeBinderCache({ uid: 'bob', total: 0, cards: [] }, storage);
  assert.equal(storage.getItem(LANDING_BINDER_KEY), null);
  storage.setItem(LANDING_BINDER_KEY, '{nope');
  assert.equal(readBinderCache('bob', storage), null);
  storage.setItem(LANDING_BINDER_KEY, JSON.stringify({ v: 0, uid: 'bob', cards: page.cards }));
  assert.equal(readBinderCache('bob', storage), null);
  clearBinderCache(storage);
  assert.equal(storage.map.size, 0);
});

test('signing out drops the stored binder page with the session', () => {
  const storage = memoryStore();
  writeAuthSession({ uid: 'alice' }, storage);
  writeBinderCache(binderPage({ uid: 'alice', items: rows(3), itemCount: 3 }, { image, href }), storage);
  assert.ok(storage.getItem(LANDING_BINDER_KEY));
  clearAuthSession(storage);
  assert.equal(storage.getItem(LANDING_BINDER_KEY), null);
});

test('samePage compares owner, count and every card in order', () => {
  const a = binderPage({ uid: 'u1', items: rows(5), itemCount: 9 }, { image, href });
  assert.ok(samePage(a, binderPage({ uid: 'u1', items: rows(5), itemCount: 9 }, { image, href })));
  assert.ok(!samePage(a, binderPage({ uid: 'u2', items: rows(5), itemCount: 9 }, { image, href })));
  assert.ok(!samePage(a, binderPage({ uid: 'u1', items: rows(5), itemCount: 10 }, { image, href })));
  assert.ok(!samePage(a, binderPage({ uid: 'u1', items: rows(5).reverse(), itemCount: 9 }, { image, href })));
  assert.ok(!samePage(null, a));
});
