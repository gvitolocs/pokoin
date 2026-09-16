const FIGURE_MASK_REV = 'sam21-1';

/** Transparent SAM silhouette for the CLIP painting, never a rectangular crop. */
export function artworkFigureMaskSrc(card = {}) {
  const version = String(card.version || card.version_set || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    return '';
  }
  return `/card-images/figure-masks/${version}.webp?v=${FIGURE_MASK_REV}`;
}
