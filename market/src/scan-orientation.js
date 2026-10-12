/**
 * BREAK and LEGEND scans should be stored portrait (63:88) with the name bar
 * on the left, and every `.is-landscape` surface (desk, zoom, suggest, album)
 * rotates them +90deg. Some leftovers are stored already landscape (88:63,
 * name bar on top): rotating those squashes them and turns the name bar to
 * the right edge (Golduck BREAK, BREAKpoint 18/122). Each loaded image is
 * stamped with its file orientation, and styles.css rotates only portrait
 * files.
 */
export function scanOrientation(width, height) {
  if (!(width > 0) || !(height > 0)) return '';
  return width > height ? 'landscape' : 'portrait';
}

export function markScanOrientation(img) {
  if (!img || img.tagName !== 'IMG') return;
  const orientation = scanOrientation(img.naturalWidth, img.naturalHeight);
  if (orientation && img.dataset.scanOrient !== orientation) {
    img.dataset.scanOrient = orientation;
  }
}

/** One capture-phase listener for every <img> the app ever loads (load does
 * not bubble), plus the images that finished before it was installed. */
export function installScanOrientation(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || doc.pokoinScanOrientation) return;
  doc.pokoinScanOrientation = true;
  doc.addEventListener('load', (event) => markScanOrientation(event.target), true);
  for (const img of doc.images || []) {
    if (img.complete) markScanOrientation(img);
  }
}
