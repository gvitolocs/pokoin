const FIGURE_MASK_REV = 'clean-2';

const figureBoxLoads = new Map();

/** Transparent SAM silhouette for the CLIP painting, never a rectangular crop.
 * Served from the cleaned set: fill-holes + island removal + edge closing. */
export function artworkFigureMaskSrc(card = {}) {
  const version = String(card.version || card.version_set || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    return '';
  }
  return `/card-images/figure-masks-clean/${version}.webp?v=${FIGURE_MASK_REV}`;
}

/** Alpha bounding box of a full-card mask as card fractions {left, top, right, bottom}, or null if empty.
 * data = RGBA Uint8ClampedArray (ImageData.data), alpha > threshold counts as figure. */
export function figureAlphaBox(data, width, height, threshold = 127) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0 || !data) return null;
  const pixels = Math.min(w * h, Math.floor(data.length / 4));
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < pixels; i += 1) {
    if (data[i * 4 + 3] <= threshold) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return {
    left: minX / w,
    top: minY / h,
    right: (maxX + 1) / w,
    bottom: (maxY + 1) / h,
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** Scale origin for the hover pop, as card fractions {x, y} rounded to 4 decimals.
 * Intersect the figure box with the visible crop (cut = {left, top, width, height}, card fractions) and return the
 * centre of that intersection; with no box or an empty intersection, return the crop centre. */
export function figureOrigin(box, cut) {
  const cropLeft = Number(cut?.left) || 0;
  const cropTop = Number(cut?.top) || 0;
  const cropWidth = Number(cut?.width) || 0;
  const cropHeight = Number(cut?.height) || 0;
  const fallback = {
    x: round4(cropLeft + cropWidth / 2),
    y: round4(cropTop + cropHeight / 2),
  };
  if (!box) return fallback;
  const left = Math.max(Number(box.left) || 0, cropLeft);
  const top = Math.max(Number(box.top) || 0, cropTop);
  const right = Math.min(Number(box.right) || 0, cropLeft + cropWidth);
  const bottom = Math.min(Number(box.bottom) || 0, cropTop + cropHeight);
  if (right <= left || bottom <= top) return fallback;
  return {
    x: round4((left + right) / 2),
    y: round4((top + bottom) / 2),
  };
}

function figureCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

async function readFigureBox(url) {
  let bitmap;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    bitmap = await createImageBitmap(await response.blob());
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    if (!srcW || !srcH) return null;
    const height = Math.min(srcH, 160);
    const width = Math.max(1, Math.round((srcW * height) / srcH));
    const canvas = figureCanvas(width, height);
    const ctx = canvas && canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return figureAlphaBox(image.data, width, height);
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch {
        /* the box already resolved; a close failure is not a load failure */
      }
    }
  }
}

/** Browser only: fetch the mask (CDN sends Access-Control-Allow-Origin: *), decode with createImageBitmap, draw to an
 * OffscreenCanvas (fallback document.createElement('canvas')) downscaled so the height is at most 160px, read alpha
 * and resolve figureAlphaBox(...). Cache one Promise per URL in a module-level Map. Any failure resolves null (never
 * rejects, never logs noisily). Returns Promise.resolve(null) when fetch/createImageBitmap are unavailable (node). */
export function loadFigureBox(url) {
  if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') {
    return Promise.resolve(null);
  }
  const key = String(url || '');
  if (!key) return Promise.resolve(null);
  const cached = figureBoxLoads.get(key);
  if (cached) return cached;
  const pending = readFigureBox(key).then((box) => box ?? null, () => null);
  figureBoxLoads.set(key, pending);
  return pending;
}
