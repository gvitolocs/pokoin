import assert from 'node:assert/strict';
import test from 'node:test';
import { albumShade, albumShadeStyle, cardShadeStyle } from './art-shade.js';

test('album shade only accepts a saved leftover hex', () => {
  assert.equal(albumShade({ art_shade: '#3a2c18' }), '#3a2c18');
  assert.equal(albumShade({ artShade: '#AABBCC' }), '#aabbcc');
  assert.equal(albumShade({ art_shade: 'blue' }), '');
  assert.equal(albumShade({}), '');
  assert.deepEqual(albumShadeStyle({ art_shade: '#112233' }), { '--album-shade': '#112233' });
  assert.equal(albumShadeStyle({}), undefined);
});

test('card shade style feeds the desk header tile', () => {
  assert.deepEqual(cardShadeStyle({ art_shade: '#3a2c18' }), { '--card-shade': '#3a2c18' });
  assert.deepEqual(cardShadeStyle({ artShade: '#FFEEDD' }), { '--card-shade': '#ffeedd' });
  assert.equal(cardShadeStyle({}), undefined);
});
