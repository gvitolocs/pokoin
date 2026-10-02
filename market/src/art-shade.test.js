import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { albumShade, albumShadeStyle, cardShadeStyle, deskTheme, deskThemeFromShade, deskThemeVars } from './art-shade.js';

const require = createRequire(import.meta.url);
const { buildVisualTheme } = require('../../server/api/_card_visual_theme.js');

function luminance(hex) {
  const body = hex.slice(1);
  const channels = [0, 2, 4].map((i) => Number.parseInt(body.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

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

test('desk theme keeps the page darker than the tiles', () => {
  const theme = deskThemeFromShade('#3a5c8a');
  assert.ok(theme);
  assert.ok(luminance(theme.background) < luminance(theme.surface));
  assert.ok(luminance(theme.surface) < luminance(theme.surfaceRaised));
  assert.ok(luminance(theme.surfaceRaised) < luminance(theme.hero));
  const server = buildVisualTheme('#3a5c8a');
  for (const field of ['background', 'surface', 'surfaceRaised', 'hero', 'heroBorder', 'border', 'tint']) {
    assert.equal(theme[field], server[field], field);
  }
  assert.equal(deskTheme({ artShade: 'nope' }, null), null);
  assert.equal(deskTheme({ art_shade: '#3a5c8a' }).background, theme.background);
  const sand = deskThemeFromShade('#453d2d');
  const sandRgb = sand.background.slice(1);
  const sandRed = Number.parseInt(sandRgb.slice(0, 2), 16);
  const sandBlue = Number.parseInt(sandRgb.slice(4, 6), 16);
  assert.ok(sandRed > sandBlue, sand.background);
  assert.equal(
    deskTheme({ art_shade: '#453d2d' }, { background: '#050b0f', surface: '#0f171b', surfaceRaised: '#1d262a', hero: '#273b46', heroBorder: '#4a585f', border: '#32393d', tint: '#3b4a52' }).background,
    sand.background,
  );
  const vars = deskThemeVars(theme);
  assert.equal(vars['--desk-bg'], theme.background);
  assert.equal(vars['--desk-raised'], theme.surfaceRaised);
  assert.equal(deskThemeVars(null), null);
});
