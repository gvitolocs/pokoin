import { cardFromCatalogRow, imageSrc } from './api.js';
import { cdnFetchUrl, rasterSiblings } from './image-urls.js';

/** Desk "Related cards" shows at most this many tiles. */
export const RELATED_LIMIT = 12;

/**
 * The precomputed nearest neighbours of a card page (`related`: tile rows,
 * best first), mapped for CardTile. Empty when the API did not send any: the
 * desk then falls back to the client-side picker (seo.js pickRelatedCards).
 */
export function relatedFromPage(page, cardId = '') {
  const rows = Array.isArray(page?.related) ? page.related : [];
  const self = String(cardId || page?.card?.id || page?.card?.card_id || '');
  const seen = new Set(self ? [self] : []);
  const out = [];
  for (const row of rows) {
    const card = cardFromCatalogRow(row);
    const id = String(card?.id || '');
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(card);
    if (out.length >= RELATED_LIMIT) {
      break;
    }
  }
  return out;
}

/** The URL a grid CardTile requests first for this card (CardArt, not `full`). */
export function relatedThumbUrl(card) {
  return cdnFetchUrl(rasterSiblings(imageSrc(card, 'grid'))[0] || '');
}

const warmed = new Set();

/**
 * Start the related tiles' thumbnails at low priority, behind the desk scan.
 * Same URL string the tiles render, so the tile is served by this download.
 */
export function preloadRelatedThumbs(cards, { createImage = () => new Image() } = {}) {
  const started = [];
  for (const card of (cards || []).slice(0, RELATED_LIMIT)) {
    const url = relatedThumbUrl(card);
    if (!url || warmed.has(url)) {
      continue;
    }
    warmed.add(url);
    if (warmed.size > 512) {
      warmed.delete(warmed.values().next().value);
    }
    const img = createImage();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.src = url;
    started.push(url);
  }
  return started;
}

export function resetRelatedThumbsForTests() {
  warmed.clear();
}
