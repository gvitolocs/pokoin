import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUGGEST_THUMB_CACHE,
  collectPrintingThumbUrls,
  preloadSuggestThumbs,
  resetSuggestImages,
  suggestImageStats,
  suggestThumbCached,
} from './suggest-images.js';

test('thumb preload is a 128-slot LRU, not unlimited', () => {
  resetSuggestImages();
  assert.equal(SUGGEST_THUMB_CACHE, 128);
  const urls = Array.from({ length: 160 }, (_, i) => `https://cdn.pokoin.com/${i}_card_homepage.webp`);
  preloadSuggestThumbs(urls);
  const stats = suggestImageStats();
  assert.equal(stats.thumbs, SUGGEST_THUMB_CACHE);
  assert.ok(stats.queued + stats.inflight + stats.thumbs <= SUGGEST_THUMB_CACHE);
  assert.equal(suggestThumbCached(urls[0]), false);
  assert.equal(suggestThumbCached(urls[urls.length - 1]), true);
});

test('duplicate thumbs do not enqueue again', () => {
  resetSuggestImages();
  const url = 'https://cdn.pokoin.com/1_cynthia_homepage.webp';
  assert.equal(preloadSuggestThumbs([url, url]).queued, 1);
  assert.equal(preloadSuggestThumbs([url]).queued, 0);
});

test('visible thumbs jump the queue when the LRU is full', () => {
  resetSuggestImages();
  preloadSuggestThumbs(Array.from({ length: 128 }, (_, i) => `https://cdn.pokoin.com/${i}_homepage.webp`));
  preloadSuggestThumbs(['https://cdn.pokoin.com/visible_homepage.webp'], { first: true });
  assert.equal(suggestThumbCached('https://cdn.pokoin.com/visible_homepage.webp'), true);
  assert.equal(suggestImageStats().thumbs, SUGGEST_THUMB_CACHE);
});

test('collectPrintingThumbUrls skips blanks and duplicates', () => {
  const urls = collectPrintingThumbUrls(
    [
      { printings: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ],
    (printing) => (printing.id === 2 ? '' : `https://cdn.pokoin.com/${printing.id}_homepage.webp`),
  );
  assert.deepEqual(urls, [
    'https://cdn.pokoin.com/1_homepage.webp',
    'https://cdn.pokoin.com/3_homepage.webp',
  ]);
});
