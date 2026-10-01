'use strict';

// Card visual theme v1. Derives the semantic card-desk palette from the
// persisted leftover illustration shade (marketplace_leftover_art_shades):
// the shade carries the artwork's hue/personality, the levels below clamp
// OKLCH lightness/chroma so pathological artwork can't break the dark
// surface hierarchy or white-text contrast.
//
// Validity is keyed on the artwork's content identity (sha256 of the
// canonical leftover JPEG, `artwork_identity`), never on the shade: two
// artworks can quantize to the same shade, and an artwork can change while
// producing the same shade. A persisted theme row is trusted only when its
// artwork_identity equals the current one; otherwise the theme is
// re-derived from the current shade.

const THEME_VERSION = 'v1';

const HEX = /^#[0-9a-fA-F]{6}$/;

// sRGB ↔ OKLCH, Björn Ottosson's reference matrices.
const SRGB_TO_LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_TO_OKLAB = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
const OKLAB_TO_LMS = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LMS_TO_SRGB = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

function dot(matrix, a, b, c) {
  return matrix.map((row) => row[0] * a + row[1] * b + row[2] * c);
}

function srgbToLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * (value ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function hexToRgb(hex) {
  if (!HEX.test(hex)) {
    return null;
  }
  const body = hex.slice(1);
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function hexToOklch(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  const [lr, lg, lb] = rgb.map(srgbToLinear);
  const lms = dot(SRGB_TO_LMS, lr, lg, lb).map((v) => Math.cbrt(v));
  const [L, a, b] = dot(LMS_TO_OKLAB, lms[0], lms[1], lms[2]);
  const chroma = Math.sqrt(a * a + b * b);
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) {
    hue += 360;
  }
  return { l: L, c: chroma, h: hue };
}

function oklchToHex({ l, c, h }) {
  const rad = (h * Math.PI) / 180;
  const a = Math.cos(rad) * c;
  const b = Math.sin(rad) * c;
  const lmsPrime = dot(OKLAB_TO_LMS, l, a, b);
  const lms = lmsPrime.map((v) => v * v * v);
  const [lr, lg, lb] = dot(LMS_TO_SRGB, lms[0], lms[1], lms[2]);
  return rgbToHex([linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** WCAG 2 contrast ratio (white text is the desk's ink on these surfaces). */
function contrastRatio(hexA, hexB) {
  const lum = (hex) => {
    const rgb = hexToRgb(hex);
    if (!rgb) {
      return 0;
    }
    const [r, g, b] = rgb.map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(hexA);
  const b = lum(hexB);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';

function shade(level) {
  return oklchToHex(level);
}

/**
 * Semantic card-desk palette from a leftover shade (`#rrggbb`). Hue and a
 * scaled chroma carry the artwork personality; lightness is pinned per level
 * so bright, near-black, and neon artwork all land in Pokoin's hierarchy.
 * `artworkIdentity` (sha256 of the canonical leftover JPEG) is stamped on
 * the result so downstream caches can prove freshness.
 */
function buildVisualTheme(artShade, artworkIdentity = '') {
  const source = hexToOklch(artShade);
  if (!source) {
    return null;
  }
  const hue = source.c < 0.02 ? 265 : source.h;
  const chroma = source.c;
  const background = {
    l: clamp(source.l * 0.42, 0.145, 0.19),
    c: Math.min(chroma * 0.55, 0.03),
    h: hue,
  };
  const surface = {
    l: clamp(background.l + 0.055, 0.2, 0.245),
    c: Math.min(chroma * 0.6, 0.034),
    h: hue,
  };
  const surfaceRaised = {
    l: clamp(surface.l + 0.05, 0.26, 0.31),
    c: Math.min(chroma * 0.65, 0.04),
    h: hue,
  };
  let hero = {
    l: clamp(source.l + 0.04, 0.34, 0.52),
    c: Math.min(chroma * 1.35, 0.115),
    h: hue,
  };
  for (let guard = 0; guard < 8 && contrastRatio(shade(hero), WHITE) < 4.5; guard += 1) {
    hero = { ...hero, l: hero.l - 0.025 };
  }
  const tint = {
    l: clamp(hero.l + 0.05, 0.4, 0.55),
    c: Math.min(chroma, 0.075),
    h: hue,
  };
  const border = { l: 0.34, c: Math.min(chroma * 0.5, 0.035), h: hue };
  const heroBorder = { l: 0.45, c: Math.min(chroma * 0.9, 0.09), h: hue };
  return {
    version: THEME_VERSION,
    artworkShade: String(artShade).toLowerCase(),
    artworkIdentity: String(artworkIdentity || ''),
    hue: Math.round(hue * 1000) / 1000,
    chroma: Math.round(chroma * 1000) / 1000,
    background: shade(background),
    surface: shade(surface),
    surfaceRaised: shade(surfaceRaised),
    hero: shade(hero),
    heroBorder: shade(heroBorder),
    border: shade(border),
    tint: shade(tint),
  };
}

const THEME_HEX_FIELDS = [
  'background',
  'surface',
  'surfaceRaised',
  'hero',
  'heroBorder',
  'border',
  'tint',
];

// Persisted rows are snake_case; the served payload is camelCase.
const ROW_COLUMN = {
  surfaceRaised: 'surface_raised',
  heroBorder: 'hero_border',
};

function rowHex(row, field) {
  const value = row[ROW_COLUMN[field] || field];
  if (value == null) {
    return '';
  }
  const hex = String(value).toLowerCase();
  return HEX.test(hex) ? hex : '';
}

/** Persisted DB row → theme payload, but only when its artwork identity
 * equals the current one and the theme version is current. The shade is
 * source metadata, not the correctness key: an artwork replaced by another
 * that samples to the same shade must invalidate the row. Rows without a
 * stored identity (never resampled since 085) are unverifiable and are
 * re-derived. Returns null when there is no usable current shade. */
function visualThemeForShade(row, artShade, artworkIdentity = '') {
  const normalizedShade = String(artShade || '').toLowerCase();
  if (!HEX.test(normalizedShade)) {
    return null;
  }
  const currentIdentity = String(artworkIdentity || '');
  if (row && typeof row === 'object') {
    const version = String(row.version || '');
    const rowIdentity = String(row.artwork_identity || row.artworkIdentity || '');
    const hexes = THEME_HEX_FIELDS.map((field) => rowHex(row, field));
    if (
      version === THEME_VERSION
      && currentIdentity
      && rowIdentity === currentIdentity
      && hexes.every(Boolean)
    ) {
      const theme = { version, artworkShade: normalizedShade, artworkIdentity: rowIdentity };
      for (const [index, field] of THEME_HEX_FIELDS.entries()) {
        theme[field] = hexes[index];
      }
      const hue = Number(row.hue);
      const chroma = Number(row.chroma);
      theme.hue = Number.isFinite(hue) ? hue : 0;
      theme.chroma = Number.isFinite(chroma) ? chroma : 0;
      return theme;
    }
  }
  return buildVisualTheme(normalizedShade, currentIdentity);
}

/** Compact packed theme for card summaries: `v1` + the seven semantic hexes
 * concatenated in field order (44 chars). Lets tiles/typeahead/search/recent
 * identities carry the exact theme with no client-side color math. */
function packVisualTheme(theme) {
  if (!theme || typeof theme !== 'object' || String(theme.version) !== THEME_VERSION) {
    return '';
  }
  let packed = THEME_VERSION;
  for (const field of THEME_HEX_FIELDS) {
    const hex = String(theme[field] || '').toLowerCase();
    if (!HEX.test(hex)) {
      return '';
    }
    packed += hex.slice(1);
  }
  return packed;
}

module.exports = {
  THEME_VERSION,
  THEME_HEX_FIELDS,
  buildVisualTheme,
  visualThemeForShade,
  packVisualTheme,
  contrastRatio,
  hexToOklch,
  oklchToHex,
};
