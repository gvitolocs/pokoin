import { leftoverCdnId, leftoverUrlFromCard } from './card-stub.js';

export function preferFullImage(value) {
  return rewritePublicImage(value, { allowPreview: false });
}

/** One Piece / Riftbound / other TCG masters stay png/webp/jpg. Pokemon leftover scans are JPEG. */
export function isPrefixedCatalog(value) {
  return /(?:^|\/)(one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery|palworld|cyberpunk|weiss-schwarz|final-fantasy|force-of-will|world-of-warcraft|battle-spirits-saga|star-wars-destiny|dragon-born|my-little-pony|the-spoils)\//i.test(String(value || ''));
}

import CATALOG_IMAGE_CACHE from './data/catalog-image-cache.json' with { type: 'json' };
import SMALL_SCAN_IDS from './data/small-scan-ctf1.json' with { type: 'json' };
import POKOIN_PLACEHOLDER_IDS from './data/pokoin-placeholder-leftovers.json' with { type: 'json' };

const ID_LISTS = {
  'small-scan-ctf1': SMALL_SCAN_IDS,
  'pokoin-placeholder-leftovers': POKOIN_PLACEHOLDER_IDS,
};

/** `?v=` busters for leftover JPEGs replaced under the same immutable CDN key.
 * The table is shared with the Rust card page (deskArtUrl); see the JSON. */
const CACHE_RULES = CATALOG_IMAGE_CACHE.rules.map((rule) => ({
  token: rule.token,
  ids: new Set([...(rule.ids || []), ...(ID_LISTS[rule.idList] || [])].map(Number)),
  ranges: rule.ranges || [],
}));

/** Leftover ct_ids whose Pi JPEG was just replaced (immutable CDN cache). */
function catalogCacheToken(id) {
  const value = Number(id);
  for (const rule of CACHE_RULES) {
    if (rule.ids.has(value) || rule.ranges.some(([from, to]) => value >= from && value <= to)) {
      return rule.token;
    }
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

/** Live pokoin.com zone Redirect Rule turns `/card-images/*` into a 301 to
 * `cdn.pokoin.com`. Point `<img>` / fetch at the CDN host directly so refresh
 * does not pay one redirect RTT per tile. */
export const CDN_ORIGIN = 'https://cdn.pokoin.com';

export function cdnFetchUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.startsWith('data:') || text.startsWith('blob:')) {
    return text;
  }
  try {
    const url = new URL(text, 'https://pokoin.com');
    if (url.hostname === 'cdn.pokoin.com') {
      return `${CDN_ORIGIN}${url.pathname}${url.search}`;
    }
    if (url.pathname.startsWith('/card-images/')) {
      return `${CDN_ORIGIN}${url.pathname.slice('/card-images'.length)}${url.search}`;
    }
  } catch (_) {
    /* fall through */
  }
  if (text.startsWith('/card-images/')) {
    return `${CDN_ORIGIN}${text.slice('/card-images'.length)}`;
  }
  return text;
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
