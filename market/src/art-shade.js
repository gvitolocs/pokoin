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

/** Thirty-two desk palettes. One is neutral; the rest are even hue steps.
 * The page snaps every leftover shade onto one of these so a card switch
 * is a local lookup, not a new color computed after the card request. */
export const SHADE_BUCKETS = 32;

const BUCKET_THEMES = (() => {
  const themes = [deskThemeFromShade(oklchToHex({ l: 0.38, c: 0.012, h: 265 }))];
  const chromatic = SHADE_BUCKETS - 1;
  for (let i = 1; i < SHADE_BUCKETS; i += 1) {
    const hue = ((i - 1) * 360) / chromatic;
    // A small lightness step keeps neighboring hues from quantizing
    // to the same desk hex (deep reds otherwise share #3a0000).
    const l = 0.34 + ((i * 5) % 7) * 0.012;
    themes.push(deskThemeFromShade(oklchToHex({ l, c: 0.08, h: hue })));
  }
  return themes;
})();

export function bucketIndex(hex) {
  const raw = String(hex || '').trim().toLowerCase();
  if (!HEX.test(raw)) return null;
  const source = hexToOklch(raw);
  if (source.c < 0.02) return 0;
  const chromatic = SHADE_BUCKETS - 1;
  let best = 1;
  let bestDist = 360;
  for (let i = 1; i < SHADE_BUCKETS; i += 1) {
    const hue = ((i - 1) * 360) / chromatic;
    const dist = Math.min(Math.abs(source.h - hue), 360 - Math.abs(source.h - hue));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function themeForBucket(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= SHADE_BUCKETS) return null;
  return BUCKET_THEMES[i];
}

const BUCKET_KEY = 'pokoin.shadeBucket.v1';
const IDENTITY_KEY = 'pokoin.deskIdentity.v1';
const bucketListeners = new Set();
let bucketMap = null;
let identityMap = null;
const warmingBuckets = new Set();

function browserStore() {
  try {
    const local = globalThis.localStorage;
    if (local && typeof local.getItem === 'function') return local;
  } catch {
    /* private mode or node */
  }
  return null;
}

function loadJsonMap(key, slot) {
  if (slot.current) return slot.current;
  slot.current = {};
  try {
    const parsed = JSON.parse(browserStore()?.getItem(key) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      slot.current = parsed;
    }
  } catch {
    slot.current = {};
  }
  return slot.current;
}

const bucketSlot = { current: null };
const identitySlot = { current: null };

function loadBuckets() {
  bucketMap = loadJsonMap(BUCKET_KEY, bucketSlot);
  return bucketMap;
}

function loadIdentity() {
  identityMap = loadJsonMap(IDENTITY_KEY, identitySlot);
  return identityMap;
}

function writeMap(key, map) {
  const keys = Object.keys(map);
  if (keys.length > 4000) {
    for (let i = 0; i < keys.length - 3000; i += 1) delete map[keys[i]];
  }
  try {
    browserStore()?.setItem(key, JSON.stringify(map));
  } catch {
    /* quota */
  }
}

function notifyBuckets() {
  for (const fn of bucketListeners) fn();
}

export function peekCardBucket(cardId) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const index = Number(loadBuckets()[id]);
  return Number.isInteger(index) && index >= 0 && index < SHADE_BUCKETS ? index : null;
}

export function themeForCardId(cardId) {
  const index = peekCardBucket(cardId);
  return index == null ? null : themeForBucket(index);
}

/** Remember which of the 32 palettes this printing uses. */
export function rememberCardBucket(cardId, hexOrIndex) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const index = typeof hexOrIndex === 'number' ? hexOrIndex : bucketIndex(hexOrIndex);
  if (index == null) return null;
  const map = loadBuckets();
  if (map[id] === index) return index;
  map[id] = index;
  writeMap(BUCKET_KEY, map);
  notifyBuckets();
  return index;
}

export function subscribeShadeBuckets(listener) {
  bucketListeners.add(listener);
  return () => bucketListeners.delete(listener);
}

/** Artist and emoji for the first paint, kept beside the bucket index. */
export function rememberDeskIdentity(card) {
  const id = String(card?.id || card?.card_id || '').trim();
  if (!/^\d+$/.test(id)) return;
  const artist = String(card?.artist || card?.illustrator || '').trim();
  const emoji = String(card?.emoji || card?.cardIdentityEmoji || '').trim();
  const shade = albumShade(card);
  if (!artist && !emoji && !shade) return;
  const map = loadIdentity();
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};
  const next = {
    artist: artist || prev.artist || '',
    emoji: emoji || prev.emoji || '',
  };
  if (shade) rememberCardBucket(id, shade);
  if (prev.artist === next.artist && prev.emoji === next.emoji) return;
  map[id] = next;
  writeMap(IDENTITY_KEY, map);
}

export function peekDeskIdentity(cardId) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const row = loadIdentity()[id];
  if (!row || typeof row !== 'object') return null;
  const artist = String(row.artist || '').trim();
  const emoji = String(row.emoji || '').trim();
  if (!artist && !emoji) return null;
  return {
    id,
    card_id: id,
    artist,
    illustrator: artist,
    emoji,
    cardIdentityEmoji: emoji,
  };
}

function averageArtHex(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.drawImage(img, 0, 0, 24, 32);
  const data = ctx.getImageData(2, 4, 20, 12).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  if (!n) return '';
  return rgbToHex([r / n, g / n, b / n]);
}

/** Sample a suggest thumb into the local 32 once. Later rows read the bucket. */
export function warmCardBucket(cardId, imageUrl) {
  const id = String(cardId || '').trim();
  const url = String(imageUrl || '').trim();
  if (!/^\d+$/.test(id) || !url || peekCardBucket(id) != null || warmingBuckets.has(id)) return;
  if (typeof Image === 'undefined') return;
  warmingBuckets.add(id);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    warmingBuckets.delete(id);
    try {
      const hex = averageArtHex(img);
      if (hex) rememberCardBucket(id, hex);
    } catch {
      /* canvas blocked */
    }
  };
  img.onerror = () => {
    warmingBuckets.delete(id);
  };
  img.src = url;
}

/** The desk color is one of the 32 local palettes. An API theme is not
 * painted first: that was the baseline color flashing under the artwork. */
export function deskTheme(card, visualTheme) {
  const shade = albumShade(card);
  const id = card?.id || card?.card_id;
  if (shade) {
    const theme = themeForBucket(bucketIndex(shade));
    if (theme) return theme;
  }
  const remembered = themeForCardId(id);
  if (remembered) return remembered;
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
