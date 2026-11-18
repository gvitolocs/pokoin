import test from 'node:test';
import assert from 'node:assert/strict';

import { artworkFigureMaskSrc, figureAlphaBox, figureOrigin, loadFigureBox } from './art-figure-mask.js';

test('figure mask is keyed by same-painting CLIP version', () => {
  assert.equal(
    artworkFigureMaskSrc({ version: 'v219698' }),
    '/card-images/figure-masks-clean/v219698.webp?v=clean-2',
  );
});

test('full-art versions cut from the artofpkm clean artwork use their own set', () => {
  assert.equal(
    artworkFigureMaskSrc({ version: 'v436094' }),
    '/card-images/figure-masks-artofpkm/v436094.webp?v=artofpkm-1',
  );
});

test('missing or unsafe versions never become mask paths', () => {
  assert.equal(artworkFigureMaskSrc({}), '');
  assert.equal(artworkFigureMaskSrc({ version: '../secret' }), '');
});

function paint(width, height, rect, alpha) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      data[(y * width + x) * 4 + 3] = alpha;
    }
  }
  return data;
}

test('empty alpha is not a figure', () => {
  assert.equal(figureAlphaBox(new Uint8ClampedArray(8 * 8 * 4), 8, 8), null);
});

test('a single opaque rect is exact card fractions', () => {
  const data = paint(10, 8, { left: 2, top: 1, right: 6, bottom: 4 }, 255);
  assert.deepEqual(figureAlphaBox(data, 10, 8), {
    left: 0.2,
    top: 0.125,
    right: 0.6,
    bottom: 0.5,
  });
});

test('alpha at or below the threshold is ignored', () => {
  const dim = paint(4, 4, { left: 1, top: 1, right: 3, bottom: 3 }, 127);
  assert.equal(figureAlphaBox(dim, 4, 4), null);
  const lit = paint(4, 4, { left: 1, top: 1, right: 3, bottom: 3 }, 128);
  assert.deepEqual(figureAlphaBox(lit, 4, 4), {
    left: 0.25,
    top: 0.25,
    right: 0.75,
    bottom: 0.75,
  });
});

test('figureOrigin uses the crop centre when the figure box is missing or outside', () => {
  const cut = { left: 0.08, top: 0.12, width: 0.84, height: 0.36 };
  assert.deepEqual(figureOrigin(null, cut), { x: 0.5, y: 0.3 });
  assert.deepEqual(figureOrigin(undefined, cut), { x: 0.5, y: 0.3 });
  assert.deepEqual(
    figureOrigin({ left: 0.95, top: 0.9, right: 1, bottom: 1 }, cut),
    { x: 0.5, y: 0.3 },
  );
  assert.deepEqual(
    figureOrigin(null, { left: 0, top: 0, width: 1 / 3, height: 1 / 3 }),
    { x: 0.1667, y: 0.1667 },
  );
});

test('figureOrigin is the box centre when the figure sits inside the crop', () => {
  const cut = { left: 0.08, top: 0.12, width: 0.84, height: 0.36 };
  assert.deepEqual(
    figureOrigin({ left: 0.2, top: 0.14, right: 0.5, bottom: 0.3 }, cut),
    { x: 0.35, y: 0.22 },
  );
});

test('figureOrigin is the centre of the crop intersection', () => {
  const cut = { left: 0.08, top: 0.12, width: 0.84, height: 0.36 };
  assert.deepEqual(
    figureOrigin({ left: 0, top: 0, right: 0.2, bottom: 0.2 }, cut),
    { x: 0.14, y: 0.16 },
  );
});

test('loadFigureBox resolves null outside the browser', async () => {
  assert.equal(await loadFigureBox('/card-images/figure-masks-clean/v219698.webp'), null);
});
