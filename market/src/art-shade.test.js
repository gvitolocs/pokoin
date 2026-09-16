import assert from 'node:assert/strict';
import test from 'node:test';
import { albumShade, albumShadeStyle } from './art-shade.js';

test('album shade only accepts a saved leftover hex', () => {
  assert.equal(albumShade({ art_shade: '#3a2c18' }), '#3a2c18');
  assert.equal(albumShade({ artShade: '#AABBCC' }), '#aabbcc');
  assert.equal(albumShade({ art_shade: 'blue' }), '');
  assert.equal(albumShade({}), '');
  assert.deepEqual(albumShadeStyle({ art_shade: '#112233' }), { '--album-shade': '#112233' });
  assert.equal(albumShadeStyle({}), undefined);
});
