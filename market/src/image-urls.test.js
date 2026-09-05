import assert from 'node:assert/strict';
import test from 'node:test';
import { homepageDerivativeUrl, preferFullImage, rasterSiblings } from './image-urls.js';

test('grid tiles rewrite leftover JPEG to _homepage.webp', () => {
  const src = homepageDerivativeUrl('https://cdn.pokoin.com/351691_mega-lucario-ex.jpg?v=ct1');
  assert.equal(src, '/card-images/351691_mega-lucario-ex_homepage.webp?v=ct1');
  assert.deepEqual(rasterSiblings(src), [
    '/card-images/351691_mega-lucario-ex_homepage.webp?v=ct1',
    '/card-images/351691_mega-lucario-ex.jpg?v=ct1',
  ]);
});

test('existing homepage URLs are kept for grid', () => {
  assert.equal(
    homepageDerivativeUrl('/card-images/138045_koffing-jp-expansion-pack-starter-pack_homepage.webp'),
    '/card-images/138045_koffing-jp-expansion-pack-starter-pack_homepage.webp',
  );
});

test('hero JPEG is not upgraded to homepage webp', () => {
  assert.deepEqual(
    rasterSiblings('/card-images/351691_mega-lucario-ex.jpg?v=ct1'),
    ['/card-images/351691_mega-lucario-ex.jpg?v=ct1'],
  );
});

test('full raster forces leftover JPEG even when given a homepage tile', () => {
  assert.deepEqual(
    rasterSiblings('/card-images/703354_lillie-s-determination_homepage.webp', { full: true }),
    ['/card-images/703354_lillie-s-determination.jpg'],
  );
});

test('preferFullImage strips homepage webp back to leftover JPEG', () => {
  assert.equal(
    preferFullImage('/card-images/703382_mega-lucario-ex_homepage.webp?v=ct1'),
    '/card-images/703382_mega-lucario-ex.jpg?v=ct1',
  );
});
