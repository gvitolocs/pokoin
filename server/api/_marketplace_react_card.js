'use strict';

/**
 * Canonical card JSON for React (and any JS client).
 * Grid/hero URLs are always the full raster image, never /previews/.
 */
const {
  normalizeMarketplaceRow,
  rewriteCdnPokoinPrefix,
  isMarketAvailable,
} = require('./_marketplace_row');
const { cardEmojiFields } = require('./_marketplace_card_emoji');

function cleanText(value, maxLength = 800) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeImageUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  try {
    const url = new URL(text);
    if (url.hostname !== 'cdn.pokoin.com') {
      return text;
    }
    return `/card-images${url.pathname}${url.search}`;
  } catch (_) {
    return text;
  }
}

function isPreviewPath(value) {
  const text = String(value || '');
  return (
    /\/previews\//i.test(text) ||
    /\/preview_/i.test(text) ||
    /(?:^|\/)preview_[^/?#]+\.(?:jpe?g|png|webp)(?:\?|$)/i.test(text)
  );
}

function isHomepageWebp(value) {
  return /_homepage\.webp(?:\?|$)/i.test(String(value || ''));
}

function rewriteRowImages(row = {}) {
  return {
    ...row,
    image_url: rewriteCdnPokoinPrefix(
      row.cdn_image_url || row.cdnImageUrl || row.image_url || row.imageUrl || '',
      row,
    ),
    preview_image_url: rewriteCdnPokoinPrefix(
      row.preview_image_url || row.previewImageUrl || '',
      row,
    ),
    homepage_image_url: rewriteCdnPokoinPrefix(
      row.homepage_image_url || row.homepageImageUrl || '',
      row,
    ),
  };
}

function pickFullImage(row = {}) {
  const candidates = [
    row.image_url,
    row.cdn_image_url,
    row.imageUrl,
    row.cdnImageUrl,
  ];
  for (const candidate of candidates) {
    const url = normalizeImageUrl(candidate);
    if (url && !isPreviewPath(url)) {
      return url;
    }
  }
  for (const candidate of [
    ...candidates,
    row.preview_image_url,
    row.previewImageUrl,
    row.homepage_image_url,
    row.homepageImageUrl,
  ]) {
    const url = normalizeImageUrl(candidate);
    if (url) {
      return url;
    }
  }
  return '';
}

function catalogImageSlug(value) {
  const name = String(value || '').split(/[/?#]/).filter(Boolean).pop() || '';
  return name
    .replace(/_homepage(?=\.(?:webp|jpe?g|png))/i, '')
    .replace(/\.(?:jpe?g|png|webp)$/i, '')
    .replace(/^\d+_/, '')
    .toLowerCase();
}

function homepageMatchesFullImage(homepageUrl, fullUrl) {
  const homepage = catalogImageSlug(homepageUrl);
  const full = catalogImageSlug(fullUrl);
  return Boolean(homepage && full && homepage === full);
}

function reactImageUrls(row = {}) {
  const rewritten = rewriteRowImages(row);
  const imageUrl = pickFullImage(rewritten);
  const previewImageUrl = normalizeImageUrl(rewritten.preview_image_url) || imageUrl;
  const homepageImageUrl = normalizeImageUrl(rewritten.homepage_image_url);
  const tileFromHomepage = isHomepageWebp(homepageImageUrl)
    && homepageMatchesFullImage(homepageImageUrl, imageUrl);
  return {
    imageUrl,
    previewImageUrl,
    homepageImageUrl: tileFromHomepage ? homepageImageUrl : '',
    gridImageUrl: imageUrl,
    heroImageUrl: imageUrl,
    tileImageUrl: tileFromHomepage ? homepageImageUrl : imageUrl,
  };
}

function toReactCard(row = {}) {
  const normalized = normalizeMarketplaceRow(rewriteRowImages(row));
  const images = reactImageUrls(normalized);
  const id = String(normalized.card_id ?? normalized.id ?? '');
  const name = cleanText(normalized.name, 240);
  const setName = cleanText(
    normalized.set || normalized.set_name || normalized.expansion_name,
    240,
  );
  const number = cleanText(
    normalized.number || normalized.card_number || normalized.expansion_number,
    80,
  );
  const rarity = cleanText(normalized.rarity, 120) || 'Card';
  const localizedName = cleanText(
    normalized.localized_name || normalized.localizedName,
    240,
  );
  const localizedSet = cleanText(
    normalized.localized_set || normalized.localizedSet,
    240,
  );
  const localizedRarity = cleanText(
    normalized.localized_rarity || normalized.localizedRarity,
    120,
  );
  const canonicalPath = cleanText(
    normalized.canonicalPath || normalized.canonical_path,
    800,
  );
  const available = normalized.isMarketAvailable === true || isMarketAvailable(normalized);
  const price = Number(normalized.price ?? normalized.lowest_price_pkn);
  return {
    id,
    card_id: id,
    name,
    set: setName,
    set_name: setName,
    number,
    card_number: number,
    rarity,
    ...(localizedName ? { localized_name: localizedName } : {}),
    ...(localizedSet ? { localized_set: localizedSet } : {}),
    ...(localizedRarity ? { localized_rarity: localizedRarity } : {}),
    itemKind: normalized.item_kind || normalized.itemKind || 'single',
    productType: normalized.product_type || normalized.productType || 'card',
    canonicalPath,
    canonical_path: canonicalPath,
    artist: cleanText(normalized.artist || normalized.illustrator, 120),
    illustrator: cleanText(normalized.illustrator || normalized.artist, 120),
    ...cardEmojiFields(normalized),
    version: cleanText(normalized.version, 40),
    artLayout: cleanText(normalized.artLayout || normalized.art_layout, 16),
    art_layout: cleanText(normalized.artLayout || normalized.art_layout, 16),
    artShade: cleanText(normalized.artShade || normalized.art_shade, 9),
    nationality: cleanText(normalized.nationality, 24),
    versionCount: Number(normalized.versionCount || normalized.version_count || normalized.member_count) || null,
    expansionSymbolUrl: cleanText(
      normalized.expansion_symbol_url || normalized.expansionSymbolUrl,
      800,
    ),
    ...images,
    price: Number.isFinite(price) && price > 0 ? price : null,
    stock: Number(normalized.stock || normalized.listed_quantity || 0),
    hasCardTraderListing:
      normalized.hasCardTraderListing === true ||
      normalized.has_cardtrader_listing === true,
    cardtraderEligibleListingCount: Number(
      normalized.cardtraderEligibleListingCount ||
        normalized.cardtrader_eligible_listing_count ||
        0,
    ),
    isMarketAvailable: available,
    inStock: available,
    availabilityKnown: Boolean(
      normalized.hasCardTraderListing === true
        || normalized.has_cardtrader_listing === true
        || normalized.hasCardTraderListing === false
        || normalized.has_cardtrader_listing === false
        || Number(normalized.listed_quantity || 0) > 0
        || (Number.isFinite(price) && price > 0),
    ),
  };
}

function toReactCards(rows) {
  return (Array.isArray(rows) ? rows : []).map(toReactCard);
}

function parsePublicCardId(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) {
    return '';
  }
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function parseIdList(value, max = 24) {
  const ids = [];
  const seen = new Set();
  for (const part of String(value || '').split(',')) {
    const id = parsePublicCardId(part);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    if (ids.length >= max) {
      break;
    }
  }
  return ids;
}

function parseLimit(value, fallback, max) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function parseOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.trunc(offset);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function jsonOk(res, body, cacheControl) {
  setCorsHeaders(res);
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl);
  }
  return res.status(200).json(body);
}

function withTimeout(work, ms, fallback, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (label) {
        console.warn(`${label} timed out after ${ms}ms`);
      }
      resolve(fallback);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

module.exports = {
  cleanText,
  normalizeImageUrl,
  isPreviewPath,
  isHomepageWebp,
  catalogImageSlug,
  homepageMatchesFullImage,
  reactImageUrls,
  toReactCard,
  toReactCards,
  parsePublicCardId,
  parseIdList,
  parseLimit,
  parseOffset,
  setCorsHeaders,
  jsonOk,
  withTimeout,
};
