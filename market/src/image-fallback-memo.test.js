import assert from 'node:assert/strict';
import test from 'node:test';
import { DEAD_IMAGE, rememberImageFallback, resetImageFallbackMemo, workingImage } from './image-fallback-memo.js';

function stubStorage(saved) {
  const data = new Map([['pokoin.imgFallback.v1', JSON.stringify(saved)]]);
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
  };
  resetImageFallbackMemo();
}

test('a dead mark from before the retry round is ignored, never returned as a src', () => {
  const now = Date.now();
  stubStorage({
    'https://cdn.pokoin.com/old.jpg': ['about:dead', now, 24 * 60 * 60_000],
    'https://cdn.pokoin.com/a_homepage.webp': ['https://cdn.pokoin.com/a.jpg', now],
  });
  assert.equal(workingImage('https://cdn.pokoin.com/old.jpg'), 'https://cdn.pokoin.com/old.jpg');
  assert.equal(workingImage('https://cdn.pokoin.com/a_homepage.webp'), 'https://cdn.pokoin.com/a.jpg');
  delete globalThis.localStorage;
});

test('the current dead mark is kept', () => {
  stubStorage({});
  rememberImageFallback('https://cdn.pokoin.com/b.jpg', DEAD_IMAGE, { keepMs: 6 * 60 * 60_000 });
  assert.equal(DEAD_IMAGE, 'about:dead2');
  assert.equal(workingImage('https://cdn.pokoin.com/b.jpg'), DEAD_IMAGE);
  delete globalThis.localStorage;
  resetImageFallbackMemo();
});
