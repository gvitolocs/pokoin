import test from 'node:test';
import assert from 'node:assert/strict';

import { artworkFigureMaskSrc } from './art-figure-mask.js';

test('figure mask is keyed by same-painting CLIP version', () => {
  assert.equal(
    artworkFigureMaskSrc({ version: 'v219698' }),
    '/card-images/figure-masks/v219698.webp?v=sam21-1',
  );
});

test('missing or unsafe versions never become mask paths', () => {
  assert.equal(artworkFigureMaskSrc({}), '');
  assert.equal(artworkFigureMaskSrc({ version: '../secret' }), '');
});
