import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxWindowScroll,
  peekPageView,
  peekScroll,
  rememberPageView,
  rememberScroll,
  resetScrollRestoreForTests,
  restoreWindowY,
  restoredPageView,
} from './scroll-restore.js';

test('history keys keep independent scroll slots and drop the oldest', () => {
  resetScrollRestoreForTests();
  rememberScroll('alpha', { y: 120, path: '/marketplace/en/artists/arita' });
  rememberScroll('beta', { y: 40, path: '/marketplace/en/cards/1' });
  assert.equal(peekScroll('alpha').y, 120);
  assert.equal(peekScroll('beta').y, 40);
  rememberPageView('alpha', { shown: 240, slug: 'mitsuhiro-arita' });
  assert.equal(peekPageView('alpha').shown, 240);
  assert.equal(peekScroll('alpha').y, 120);
  assert.equal(restoredPageView('PUSH', 'alpha'), null);
  assert.equal(restoredPageView('POP', 'alpha').shown, 240);
  assert.equal(restoredPageView('POP', 'alpha', '/marketplace/en/cards/1'), null);
});

test('PUSH visits do not inherit another entry\'s album view', () => {
  resetScrollRestoreForTests();
  rememberPageView('old-arita', { shown: 480, slug: 'mitsuhiro-arita', query: 'mewtwo' });
  assert.equal(restoredPageView('PUSH', 'new-arita'), null);
  assert.equal(peekPageView('new-arita'), null);
});

test('restoreWindowY clamps to the current document height', () => {
  const scrolls = [];
  const fakeDoc = {
    documentElement: {
      scrollHeight: 900,
      scrollTop: 0,
    },
  };
  const fakeWin = {
    innerHeight: 800,
    scrollY: 0,
    document: fakeDoc,
    scrollTo(x, y) {
      scrolls.push([x, y]);
    },
    requestAnimationFrame() {
      return 0;
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    ResizeObserver: undefined,
    location: { pathname: '/marketplace/en/artists/arita', search: '' },
  };
  globalThis.window = fakeWin;
  const stop = restoreWindowY(2400);
  assert.equal(maxWindowScroll(), 100);
  assert.equal(scrolls[0][1], 100);
  stop();
  delete globalThis.window;
});
