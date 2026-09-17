import { leftoverCdnId, leftoverUrlFromCard } from './card-stub.js';

export function preferFullImage(value) {
  return rewritePublicImage(value, { allowPreview: false });
}

/** One Piece / Riftbound masters stay png/webp/jpg. Pokemon leftover scans are JPEG. */
export function isPrefixedCatalog(value) {
  return /(?:^|\/)(one-piece|riftbound)\//i.test(String(value || ''));
}

import SMALL_SCAN_IDS from './data/small-scan-ctf1.js';
import POKOIN_PLACEHOLDER_IDS from './data/pokoin-placeholder-leftovers.js';

/** Object key only — `?v=ct1` is a cache buster, not the leftover filename. */
export const CATALOG_IMAGE_CACHE = 'vv1';
export const CHAOS_RISING_IMAGE_CACHE = 'cr2';
export const WCD_2025_IMAGE_CACHE = 'wcd25';
export const PLACEHOLDER_SCAN_CACHE = 'ph1';
export const PLACEHOLDER_SCAN_CACHE_2 = 'ph2';
export const POKOIN_PLACEHOLDER_CACHE = 'pkph1';
export const BASE_SET_UNLIMITED_CACHE = 'bsu2';
export const SMALL_SCAN_CACHE = 'ctf1';
export const ODD_SCAN_CACHE = 'sv312';
/** Team Up Charizard 014/181 (CT 397269) swapped off the pokemontcg.io digital onto CT's scan. */
export const TEAM_UP_CHARIZARD_CACHE = 'ct397';
/** Leftovers whose missing-card coin was replaced by a real scan; keyed by leftover ct_id. */
const RESCAN_IDS = new Set([286866, 122705, 126934, 331755, 331756]);
export const RESCAN_CACHE = 'rscan1';
const SMALL_SCAN_ID_SET = new Set(SMALL_SCAN_IDS.map(Number));
const POKOIN_PLACEHOLDER_ID_SET = new Set(POKOIN_PLACEHOLDER_IDS.map(Number));
/** 312×437 catalog thumbs replaced with CardTrader full (SV Magnemite cohort). */
const ODD_SCAN_ID_SET = new Set([241617, 241904, 241905, 241906]);

/** Leftover ct_ids whose Pi JPEG was just replaced (immutable CDN cache). */
function catalogCacheToken(id) {
  const value = Number(id);
  if (value === 397269) {
    return TEAM_UP_CHARIZARD_CACHE;
  }
  if (RESCAN_IDS.has(value)) {
    return RESCAN_CACHE;
  }
  if (POKOIN_PLACEHOLDER_ID_SET.has(value)) {
    return POKOIN_PLACEHOLDER_CACHE;
  }
  if (ODD_SCAN_ID_SET.has(value)) {
    return ODD_SCAN_CACHE;
  }
  if (SMALL_SCAN_ID_SET.has(value)) {
    return SMALL_SCAN_CACHE;
  }
  if (
    (value >= 373736 && value <= 373804)
    || (value >= 379038 && value <= 379250)
  ) {
    return PLACEHOLDER_SCAN_CACHE_2;
  }
  if (
    (value >= 373100 && value <= 373456)
    || value === 318878
    || value === 374919
    || value === 389954
    || value === 389970
    || value === 390273
    || value === 390274
  ) {
    return PLACEHOLDER_SCAN_CACHE;
  }
  if (value >= 150227 && value <= 150572) {
    return CATALOG_IMAGE_CACHE;
  }
  if (value >= 389941 && value <= 390062) {
    return CHAOS_RISING_IMAGE_CACHE;
  }
  if (value >= 385517 && value <= 385605) {
    return WCD_2025_IMAGE_CACHE;
  }
  if ((value >= 111148 && value <= 111249) || (value >= 55574 && value <= 55624)) {
    return BASE_SET_UNLIMITED_CACHE;
  }
  return '';
}

function withCatalogCache(url) {
  const text = String(url || '');
  if (!text || isPrefixedCatalog(text) || /(?:^|\/)competitive\//i.test(text)) {
    return text;
  }
  const token = catalogCacheToken(catalogImageId(text));
  if (!token || /[?&]v=/.test(text)) {
    return text;
  }
  return `${text}${text.includes('?') ? '&' : '?'}v=${token}`;
}

function catalogFileName(value) {
  const path = String(value || '').split(/[?#]/)[0];
  return path.split('/').filter(Boolean).pop() || '';
}

/** Filename stem after `{id}_` and `_homepage`, for catching leftover/public-id collisions. */
export function catalogImageSlug(value) {
  const name = catalogFileName(value);
  return name
    .replace(/_homepage(?=\.(?:webp|jpe?g|png))/i, '')
    .replace(/\.(?:jpe?g|png|webp)$/i, '')
    .replace(/^\d+_/, '')
    .toLowerCase();
}

export function catalogImageId(value) {
  const name = catalogFileName(value);
  const match = name.match(/^(\d+)_/);
  return match ? match[1] : '';
}

/** True when the file key is leftover `ct_id` (public / 2). Public-id prefixes collide (Net Ball 245292 vs Cyndaquil). */
export function leftoverKeyMatchesCard(url, cardId) {
  const fileId = catalogImageId(url);
  const leftover = leftoverCdnId(cardId);
  return Boolean(fileId && leftover && fileId === leftover);
}

/** Rewrite `{publicId}_` / stale leftover prefixes to this card's leftover `ct_id`. */
export function rewriteCatalogImageId(url, cardId) {
  const leftover = leftoverCdnId(cardId);
  const fileId = catalogImageId(url);
  if (!url || !leftover || !fileId || fileId === leftover || isPrefixedCatalog(url)) {
    return url;
  }
  return String(url).replace(
    new RegExp(`(^|/)(previews/)?${fileId}_`),
    `$1$2${leftover}_`,
  );
}

function catalogSlugHead(slug) {
  const parts = String(slug || '').toLowerCase().split('-').filter(Boolean);
  if (!parts.length) {
    return '';
  }
  if (parts[0].length >= 4) {
    return parts[0];
  }
  return parts.slice(0, 2).join('-');
}

/** Same leftover card, not a colliding dump (Juniper leftover 342356 vs Pikachu V-UNION public). */
export function catalogSlugMatchesCard(url, card) {
  const got = catalogImageSlug(url);
  const want = catalogImageSlug(leftoverUrlFromCard(card));
  if (!want) {
    return true;
  }
  if (!got) {
    return false;
  }
  if (got === want || got.startsWith(`${want}-`) || want.startsWith(`${got}-`)) {
    return true;
  }
  const gotHead = catalogSlugHead(got);
  const wantHead = catalogSlugHead(want);
  return Boolean(gotHead && gotHead === wantHead);
}

/** Drop CardTrader preview_ / public-id keys; keep this card's leftover JPEG. */
export function ownCatalogImage(card, advertised) {
  if (isPrefixedCatalog(advertised)) {
    return advertised;
  }
  const id = String(card?.id || card?.card_id || '');
  const withId = { ...card, id };
  if (advertised && leftoverKeyMatchesCard(advertised, id) && catalogSlugMatchesCard(advertised, withId)) {
    return withCatalogCache(advertised);
  }
  const rewritten = rewriteCatalogImageId(advertised, id);
  if (rewritten && leftoverKeyMatchesCard(rewritten, id) && catalogSlugMatchesCard(rewritten, withId)) {
    return withCatalogCache(String(rewritten).split(/[?#]/)[0]);
  }
  return withCatalogCache(leftoverUrlFromCard(withId) || rewritten || advertised || '');
}

export function homepageMatchesCatalog(homepageUrl, fullUrl) {
  const homepage = catalogImageSlug(homepageUrl);
  const full = catalogImageSlug(fullUrl);
  return Boolean(homepage && full && homepage === full);
}
export function homepageDerivativeUrl(value) {
  const full = preferFullImage(value);
  if (!full) {
    return '';
  }
  if (/_homepage\.webp(?:\?|$)/i.test(full)) {
    return full;
  }
  return full.replace(/\.(jpe?g|png|webp)(\?|$)/i, '_homepage.webp$2');
}

export function rewritePublicImage(value, { allowPreview = false } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (!allowPreview && (/\/previews\//i.test(text) || /\/preview_/i.test(text))) {
    return '';
  }
  let next = text;
  try {
    const url = new URL(text, 'https://pokoin.com');
    if (/(^|\.)cardtrader\.com$/i.test(url.hostname)) {
      return '';
    }
    if (url.hostname === 'cdn.pokoin.com') {
      next = `/card-images${url.pathname}${url.search}`;
    }
  } catch (_) {
    next = text;
  }
  if (/_homepage\.webp(?:\?|$)/i.test(next)) {
    next = next.replace(/_homepage\.webp(\?|$)/i, '.jpg$1');
  }
  if (isPrefixedCatalog(next) || /(?:^|\/)competitive\//i.test(next)) {
    return next;
  }
  return withCatalogCache(next.replace(/\.(png|webp)(\?|$)/i, '.jpg$2'));
}

function catalogStem(value) {
  const text = String(value || '');
  const match = text.match(/^(.*?)(?:_homepage)?\.(?:jpe?g|png|webp)(\?.*)?$/i);
  if (!match) {
    return null;
  }
  return { stem: match[1].replace(/_homepage$/i, ''), query: match[2] || '' };
}

function uniqueUrls(list) {
  const out = [];
  for (const item of list) {
    if (item && !out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

function prefixedMasterSiblings(value) {
  const parsed = catalogStem(preferFullImage(value) || value);
  if (!parsed) {
    const fallback = preferFullImage(value);
    return fallback ? [fallback] : [];
  }
  const current = String(preferFullImage(value) || value);
  const extMatch = current.match(/\.(jpe?g|png|webp)(?:\?|$)/i);
  const ext = extMatch ? `.${extMatch[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
  const order = [ext, '.jpg', '.png', '.webp'];
  return uniqueUrls(order.map((item) => `${parsed.stem}${item}${parsed.query}`));
}

/** Grid src is `_homepage.webp` then leftover JPEG. `full` never serves the tile. */
export function rasterSiblings(value, { full = false } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }
  if (full) {
    if (isPrefixedCatalog(text)) {
      return prefixedMasterSiblings(text);
    }
    const jpeg = preferFullImage(text);
    if (!jpeg) {
      return [];
    }
    // Desk is leftover JPEG. If that 404s (Pi miss, R2 has no catalog JPEGs)
    // still paint the leftover tile rather than missing-card.webp.
    return uniqueUrls([jpeg, homepageDerivativeUrl(jpeg)].filter(Boolean));
  }
  if (/_homepage\.webp(?:\?|$)/i.test(text)) {
    const jpeg = text.replace(/_homepage\.webp(\?|$)/i, '.jpg$1');
    if (isPrefixedCatalog(text)) {
      return uniqueUrls([text, ...prefixedMasterSiblings(jpeg || text)]);
    }
    return jpeg && jpeg !== text ? [text, jpeg] : [text];
  }
  if (isPrefixedCatalog(text)) {
    const homepage = homepageDerivativeUrl(text);
    return uniqueUrls([homepage, ...prefixedMasterSiblings(text)].filter(Boolean));
  }
  return [text];
}
