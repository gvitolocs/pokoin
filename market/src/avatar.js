/** Profile picture: validation, crop geometry and export.
 *
 * The browser does the crop; the API (`POST /api/upload-profile-picture`)
 * only re-encodes to a 256 px WebP. Pure helpers are exported for tests;
 * the DOM helpers need a browser (canvas, Image).
 */

/** Longest side the cropper works on. Phone photos (48 MP) exceed iOS canvas
 * limits, and nobody zooms past this on a 512 px avatar. */
export const AVATAR_SOURCE_MAX = 2048;
/** Exported square. The API keeps 256; 512 stays sharp on 2× screens. */
export const AVATAR_EXPORT_SIZE = 512;
/** Raw file the picker accepts before downscaling. */
export const AVATAR_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** The API rejects bodies over 6 MB of decoded image. */
export const AVATAR_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif';

const DECODABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']);

/** Only https URLs are rendered; anything else falls back to initials. */
export function safeAvatarUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

/** What an <img> may show: a stored https photo, or the editor's local
 * data:/blob: preview. Never persisted — storage goes through safeAvatarUrl. */
export function displayableAvatarUrl(value) {
  const text = String(value || '').trim();
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(text) || text.startsWith('blob:')) return text;
  return safeAvatarUrl(text);
}

/** One or two letters for the fallback disc. */
export function avatarInitials(name) {
  const clean = String(name || '')
    .replace(/@.*$/, '')
    .replace(/^0x[0-9a-f]+$/i, '')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .trim();
  if (!clean) return '?';
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1
    ? words[0][0] + words[words.length - 1][0]
    : [...words[0]].slice(0, 2).join('');
  return letters.toUpperCase();
}

/** Returns an error message, or '' when the file can be cropped. */
export function validateAvatarFile(file) {
  if (!file) return 'Choose a photo first.';
  const type = String(file.type || '').toLowerCase();
  if (type && !type.startsWith('image/')) return 'That file is not an image.';
  if (type && !DECODABLE.has(type)) return 'Use a JPG, PNG, WebP or GIF photo.';
  if (Number(file.size) > AVATAR_FILE_MAX_BYTES) return 'That photo is over 25 MB. Choose a smaller one.';
  if (Number(file.size) === 0) return 'That file is empty.';
  return '';
}

/** Scale (w, h) down so the longest side is at most `max`. Never upscales. */
export function fitWithin(width, height, max = AVATAR_SOURCE_MAX) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

export function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Bounding box of a w×h rectangle rotated by `rotation` degrees. */
export function rotatedSize(width, height, rotation) {
  const rad = toRadians(rotation);
  return {
    width: Math.abs(Math.cos(rad) * width) + Math.abs(Math.sin(rad) * height),
    height: Math.abs(Math.sin(rad) * width) + Math.abs(Math.cos(rad) * height),
  };
}

/** Next quarter turn, kept in [0, 360). */
export function nextRotation(rotation, step = 90) {
  return (((Math.round(rotation / 90) * 90 + step) % 360) + 360) % 360;
}

/** Clamp a react-easy-crop pixel area to the rotated image as a square, so
 * the export never samples outside it (rounding can overshoot by a pixel)
 * and never stretches the face. */
export function clampArea(area, bounds) {
  const maxSide = Math.max(1, Math.min(Math.round(bounds.width), Math.round(bounds.height)));
  const side = Math.max(1, Math.min(Math.round(Math.max(area.width, area.height)), maxSide));
  const x = Math.min(Math.max(0, Math.round(area.x)), Math.max(0, Math.round(bounds.width) - side));
  const y = Math.min(Math.max(0, Math.round(area.y)), Math.max(0, Math.round(bounds.height) - side));
  return { x, y, width: side, height: side };
}

export function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// ───────────── browser only ─────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('This photo format is not supported by your browser. Try a JPG or PNG.'));
    image.src = src;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Decode the picked file once (EXIF orientation is applied by <img>),
 * downscale to AVATAR_SOURCE_MAX and hand the cropper a light object URL.
 * Caller revokes `url`. */
export async function prepareAvatarSource(file) {
  const problem = validateAvatarFile(file);
  if (problem) throw new Error(problem);
  const original = URL.createObjectURL(file);
  try {
    const image = await loadImage(original);
    const size = fitWithin(image.naturalWidth, image.naturalHeight);
    if (image.naturalWidth < 64 || image.naturalHeight < 64) {
      throw new Error('That photo is too small. Use one at least 64 px wide.');
    }
    if (size.scale === 1 && file.type !== 'image/gif') {
      return { url: original, width: size.width, height: size.height };
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, size.width, size.height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    URL.revokeObjectURL(original);
    if (!blob) throw new Error('Could not read that photo.');
    return { url: URL.createObjectURL(blob), width: size.width, height: size.height };
  } catch (error) {
    URL.revokeObjectURL(original);
    throw error;
  }
}

/** Render the chosen crop (pixels of the rotated image, as react-easy-crop
 * reports them) to a square data URL, WebP when the browser can encode it. */
export async function renderAvatar(sourceUrl, cropPixels, rotation = 0, size = AVATAR_EXPORT_SIZE) {
  const image = await loadImage(sourceUrl);
  const bounds = rotatedSize(image.naturalWidth, image.naturalHeight, rotation);
  const area = clampArea(cropPixels, bounds);

  const rotated = document.createElement('canvas');
  rotated.width = Math.round(bounds.width);
  rotated.height = Math.round(bounds.height);
  const rctx = rotated.getContext('2d');
  rctx.imageSmoothingQuality = 'high';
  rctx.translate(rotated.width / 2, rotated.height / 2);
  rctx.rotate(toRadians(rotation));
  rctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  // Transparent PNG corners would turn black in WebP/JPEG; paint the site ground.
  octx.fillStyle = '#16141a';
  octx.fillRect(0, 0, size, size);
  octx.drawImage(rotated, area.x, area.y, area.width, area.height, 0, 0, size, size);

  let dataUrl = out.toDataURL('image/webp', 0.9);
  if (!dataUrl.startsWith('data:image/webp')) {
    dataUrl = out.toDataURL('image/jpeg', 0.9);
  }
  if (dataUrlBytes(dataUrl) > AVATAR_UPLOAD_MAX_BYTES) {
    throw new Error('The cropped photo is too large to upload.');
  }
  return dataUrl;
}
