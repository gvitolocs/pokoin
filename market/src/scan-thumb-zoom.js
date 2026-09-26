/**
 * CardTrader-style cursor zoom for dense desk rows: hovering a row thumbnail
 * floats the full-resolution leftover beside the pointer. Pure geometry so
 * the box math stays unit-tested; rendering lives in components/ThumbZoom.
 */

export const SCAN_ZOOM_RATIO = 63 / 88;
export const SCAN_ZOOM_DELAY_MS = 140;
export const SCAN_ZOOM_MAX_HEIGHT = 320;

/**
 * Fixed-position box for the zoom: right of the pointer, vertically centered
 * on it, flipped left near the right viewport edge, clamped into the viewport.
 */
export function scanZoomBox({
  viewportWidth,
  viewportHeight,
  pointerX,
  pointerY,
  gap = 18,
  pad = 10,
  maxHeight = SCAN_ZOOM_MAX_HEIGHT,
} = {}) {
  const vw = Number(viewportWidth) || 0;
  const vh = Number(viewportHeight) || 0;
  const height = Math.max(0, Math.min(vh - pad * 2, Number(maxHeight) || SCAN_ZOOM_MAX_HEIGHT));
  const width = height * SCAN_ZOOM_RATIO;
  const px = Number(pointerX) || 0;
  const py = Number(pointerY) || 0;

  let left = px + gap;
  if (left + width > vw - pad) {
    left = px - gap - width;
  }
  left = Math.max(pad, Math.min(left, Math.max(pad, vw - width - pad)));
  let top = py - height / 2;
  top = Math.max(pad, Math.min(top, Math.max(pad, vh - height - pad)));

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}
