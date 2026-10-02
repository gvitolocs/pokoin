/** Persisted leftover illustration caption shade (`#rrggbb`). */

const HEX = /^#[0-9a-fA-F]{6}$/;

export function albumShade(card) {
  const hex = String(card?.artShade || card?.art_shade || '').trim();
  return HEX.test(hex) ? hex.toLowerCase() : '';
}

export function albumShadeStyle(card) {
  const shade = albumShade(card);
  return shade ? { '--album-shade': shade } : undefined;
}

/** The desk header tile tints with the same leftover shade (`--card-shade`). */
export function cardShadeStyle(card) {
  const shade = albumShade(card);
  return shade ? { '--card-shade': shade } : undefined;
}

// Same OKLCH ladder as server/api/_card_visual_theme.js. The page background
// is the darkest step; panels sit above it; the header is the most chromatic.
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
  const [lr, lg, lb] = rgb.map(srgbToLinear);
  const lms = dot(SRGB_TO_LMS, lr, lg, lb).map((v) => Math.cbrt(v));
  const [L, a, b] = dot(LMS_TO_OKLAB, lms[0], lms[1], lms[2]);
  const chroma = Math.sqrt(a * a + b * b);
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
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

function contrastRatio(hexA, hexB) {
  const lum = (hex) => {
    const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(hexA);
  const b = lum(hexB);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Desk palette from a leftover shade. Background is the darkest step, then
 * surface, then raised tiles, then the header. Hue follows the artwork.
 */
export function deskThemeFromShade(artShade) {
  const hex = String(artShade || '').trim().toLowerCase();
  if (!HEX.test(hex)) return null;
  const source = hexToOklch(hex);
  const hue = source.c < 0.02 ? 265 : source.h;
  const chroma = source.c;
  // Keep enough chroma that a dark step still reads as the artwork hue.
  // A 0.03 cap on a yellow scan collapsed to the same blue-black as the old page.
  const kept = Math.min(Math.max(chroma * 2.2, 0.055), 0.11);
  const background = {
    l: clamp(source.l * 0.5, 0.15, 0.2),
    c: kept,
    h: hue,
  };
  const surface = {
    l: clamp(background.l + 0.04, 0.19, 0.24),
    c: Math.min(kept * 1.15, 0.12),
    h: hue,
  };
  const surfaceRaised = {
    l: clamp(surface.l + 0.018, 0.21, 0.255),
    c: Math.min(kept * 1.2, 0.125),
    h: hue,
  };
  let hero = {
    l: clamp(source.l + 0.04, 0.34, 0.52),
    c: Math.min(chroma * 1.35, 0.115),
    h: hue,
  };
  for (let guard = 0; guard < 8 && contrastRatio(oklchToHex(hero), '#ffffff') < 4.5; guard += 1) {
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
    background: oklchToHex(background),
    surface: oklchToHex(surface),
    surfaceRaised: oklchToHex(surfaceRaised),
    hero: oklchToHex(hero),
    heroBorder: oklchToHex(heroBorder),
    border: oklchToHex(border),
    tint: oklchToHex(tint),
  };
}

const THEME_FIELDS = ['background', 'surface', 'surfaceRaised', 'hero', 'heroBorder', 'border', 'tint'];

/** Derive the ladder from the leftover shade. A stored API theme is only the
 * fallback when the card has no shade hex of its own. */
export function deskTheme(card, visualTheme) {
  const derived = deskThemeFromShade(albumShade(card));
  if (derived) return derived;
  const fromPage = visualTheme && typeof visualTheme === 'object' ? visualTheme : null;
  if (fromPage && THEME_FIELDS.every((field) => HEX.test(String(fromPage[field] || '')))) {
    const theme = {};
    for (const field of THEME_FIELDS) theme[field] = String(fromPage[field]).toLowerCase();
    return theme;
  }
  return null;
}

export function deskThemeVars(theme) {
  if (!theme?.background) return null;
  return {
    '--desk-bg': theme.background,
    '--desk-surface': theme.surface,
    '--desk-raised': theme.surfaceRaised,
    '--desk-hero': theme.hero,
    '--desk-hero-border': theme.heroBorder,
    '--desk-border': theme.border,
    '--desk-tint': theme.tint,
  };
}
