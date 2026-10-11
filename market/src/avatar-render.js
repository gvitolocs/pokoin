/** Profile picture DOM helpers (canvas, Image): decode the picked file and
 * render the chosen crop. Split from avatar.js so the pure helpers the header
 * avatar needs stay small in the entry chunk; only the photo editor loads this.
 */
import {
  AVATAR_EXPORT_SIZE,
  AVATAR_UPLOAD_MAX_BYTES,
  clampArea,
  dataUrlBytes,
  fitWithin,
  rotatedSize,
  toRadians,
  validateAvatarFile,
} from './avatar.js';

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
