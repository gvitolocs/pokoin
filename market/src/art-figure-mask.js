const FIGURE_MASK_REV = 'clean-2';

/** Transparent SAM silhouette for the CLIP painting, never a rectangular crop.
 * Served from the cleaned set: fill-holes + island removal + edge closing. */
export function artworkFigureMaskSrc(card = {}) {
  const version = String(card.version || card.version_set || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    return '';
  }
  return `/card-images/figure-masks-clean/${version}.webp?v=${FIGURE_MASK_REV}`;
}
