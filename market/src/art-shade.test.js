import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  albumShade,
  albumShadeStyle,
  bucketIndex,
  cardShadeStyle,
  deskTheme,
  deskThemeFromShade,
  deskThemeVars,
  peekCardBucket,
  rememberCardBucket,
  SHADE_BUCKETS,
  themeForBucket,
} from './art-shade.js';

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
  const snapped = themeForBucket(bucketIndex('#3a5c8a'));
  assert.equal(deskTheme({ art_shade: '#3a5c8a' }).background, snapped.background);
  const sand = deskThemeFromShade('#453d2d');
  const sandRgb = sand.background.slice(1);
  const sandRed = Number.parseInt(sandRgb.slice(0, 2), 16);
  const sandBlue = Number.parseInt(sandRgb.slice(4, 6), 16);
  assert.ok(sandRed > sandBlue, sand.background);
  const sandBucket = deskTheme({ id: '471518', art_shade: '#453d2d' }, {
    background: '#050b0f',
    surface: '#0f171b',
    surfaceRaised: '#1d262a',
    hero: '#273b46',
    heroBorder: '#4a585f',
    border: '#32393d',
    tint: '#3b4a52',
  });
  assert.equal(sandBucket.background, themeForBucket(bucketIndex('#453d2d')).background);
  assert.notEqual(sandBucket.background, '#050b0f');
  const bucketRgb = sandBucket.background.slice(1);
  assert.ok(
    Number.parseInt(bucketRgb.slice(0, 2), 16) > Number.parseInt(bucketRgb.slice(4, 6), 16),
    sandBucket.background,
  );
  const vars = deskThemeVars(theme);
  assert.equal(vars['--desk-bg'], theme.background);
  assert.equal(vars['--desk-raised'], theme.surfaceRaised);
  assert.equal(deskThemeVars(null), null);
});

test('artwork shades quantize into exactly 32 local themes', () => {
  assert.equal(SHADE_BUCKETS, 32);
  const seen = new Set();
  for (let i = 0; i < SHADE_BUCKETS; i += 1) {
    const theme = themeForBucket(i);
    assert.ok(theme?.background);
    seen.add(theme.background);
    assert.ok(luminance(theme.background) < luminance(theme.surface));
  }
  assert.equal(seen.size, SHADE_BUCKETS);
  assert.equal(bucketIndex('#111111'), 0);
  assert.equal(bucketIndex('#453d2d'), bucketIndex('#4a4030'));
  assert.equal(bucketIndex('nope'), null);
  assert.equal(themeForBucket(32), null);
  rememberCardBucket('471518', '#453d2d');
  assert.equal(peekCardBucket('471518'), bucketIndex('#453d2d'));
  assert.equal(deskTheme({ id: '471518' }).background, themeForBucket(bucketIndex('#453d2d')).background);
});

test('quantized themes stay inside the 32-state set', () => {
  const allowed = new Set();
  for (let i = 0; i < SHADE_BUCKETS; i += 1) allowed.add(themeForBucket(i).background);
  assert.equal(allowed.size, 32);
  const samples = [];
  for (let r = 0; r < 16; r += 1) {
    for (let g = 0; g < 16; g += 1) {
      for (let b = 0; b < 16; b += 1) {
        const hex = `#${r.toString(16)}${g.toString(16)}${b.toString(16)}${r.toString(16)}${g.toString(16)}${b.toString(16)}`;
        samples.push(hex);
      }
    }
  }
  const extremes = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#000000', '#010101', '#fefefe', '#808080', '#7f7f7f'];
  for (const hex of [...extremes, ...samples]) {
    const theme = deskTheme({ art_shade: hex });
    assert.ok(theme, hex);
    assert.ok(allowed.has(theme.background), `${hex} -> ${theme.background}`);
    assert.equal(deskTheme({ art_shade: hex }).background, theme.background, hex);
    assert.equal(bucketIndex(hex), bucketIndex(hex.toUpperCase()));
  }
  assert.equal(bucketIndex('#000000'), 0);
  assert.equal(bucketIndex('#808080'), 0);
  assert.notEqual(bucketIndex('#ff0000'), 0);
  assert.notEqual(bucketIndex('#0000ff'), bucketIndex('#ff0000'));
  assert.notEqual(bucketIndex('#00ff00'), bucketIndex('#ff0000'));
  const near = Math.abs(bucketIndex('#ff2200') - bucketIndex('#ff4400'));
  assert.ok(near <= 1, `similar reds landed ${near} buckets apart`);
});

test('a remembered bucket is local and beats a stale server theme', () => {
  rememberCardBucket('900001', '#0000ff');
  const blue = themeForBucket(bucketIndex('#0000ff'));
  const fromMemory = deskTheme({ id: '900001' }, {
    background: '#050b0f',
    surface: '#0f171b',
    surfaceRaised: '#1d262a',
    hero: '#273b46',
    heroBorder: '#4a585f',
    border: '#32393d',
    tint: '#3b4a52',
  });
  assert.equal(fromMemory.background, blue.background);
  assert.notEqual(fromMemory.background, '#050b0f');
  const red = deskTheme({ id: '900001', art_shade: '#ff0000' });
  assert.equal(red.background, themeForBucket(bucketIndex('#ff0000')).background);
  assert.notEqual(red.background, blue.background);
});

test('desk theme transition is a direct color fade, not a class reset', () => {
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const jsx = fs.readFileSync(new URL('./pages/Card.jsx', import.meta.url), 'utf8');
  assert.match(css, /html\.desk-tinted #root \{[^}]*transition: background-color 180ms ease;/s);
  assert.match(css, /html\.desk-tinted \.card-page \{[^}]*--g2: var\(--desk-bg\);/s);
  assert.match(css, /html\.desk-tinted \.card-page \.asset-header \{[^}]*background-color: var\(--desk-hero\);[^}]*background-image: none;/s);
  const themeEffect = jsx.slice(jsx.indexOf('const pageTheme = useMemo'));
  const untilUnmount = themeEffect.slice(0, themeEffect.indexOf('useEffect(() => () =>'));
  assert.doesNotMatch(untilUnmount, /classList\.remove\('desk-tinted'\)/);
  assert.match(jsx, /deskTheme\(themeCard\)/);
  assert.match(jsx, /classList\.toggle\('desk-rainbow', rarityKind === 'rainbow'\)/);
  assert.match(css, /html\.desk-rainbow \.card-page \.asset-header \{[^}]*#4c1d86 0%, #12386a/s);
});
