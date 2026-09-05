export function preferFullImage(value) {
  return rewritePublicImage(value, { allowPreview: false });
}

/** 240px `_homepage.webp` sibling of a catalog JPEG. */
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
  return next.replace(/\.(png|webp)(\?|$)/i, '.jpg$2');
}

/** Grid src is `_homepage.webp` then leftover JPEG. `full` never serves the tile. */
export function rasterSiblings(value, { full = false } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }
  if (full) {
    const jpeg = preferFullImage(text);
    return jpeg ? [jpeg] : [];
  }
  if (/_homepage\.webp(?:\?|$)/i.test(text)) {
    const jpeg = text.replace(/_homepage\.webp(\?|$)/i, '.jpg$1');
    return jpeg && jpeg !== text ? [text, jpeg] : [text];
  }
  return [text];
}
