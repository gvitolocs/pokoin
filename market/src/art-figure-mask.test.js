import test from 'node:test';
import assert from 'node:assert/strict';

import { artworkFigureMaskSrc } from './art-figure-mask.js';

test('figure mask is keyed by same-painting CLIP version', () => {
  assert.equal(
    artworkFigureMaskSrc({ version: 'v219698' }),
    '/card-images/figure-masks-clean/v219698.webp?v=clean-1',
  );
});

test('missing or unsafe versions never become mask paths', () => {
  assert.equal(artworkFigureMaskSrc({}), '');
  assert.equal(artworkFigureMaskSrc({ version: '../secret' }), '');
});
