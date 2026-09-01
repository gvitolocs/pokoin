/** Numeric shortlinks that should 302 to the stored canonical path. */

export function shortlinkCardId(pathname) {
  const path = String(pathname || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
  const patterns = [
    /^\/(\d+)$/,
    /^\/(\d+)\/[^/]+$/,
    /^\/marketplace\/(\d+)$/,
    /^\/marketplace\/(\d+)\/[^/]+$/,
    /^\/marketplace\/[a-z]{2}(?:-[a-z]{2})?\/cards\/(\d+)$/i,
  ];
  for (const pattern of patterns) {
    const match = path.match(pattern);
    if (match && /^[1-9]\d*$/.test(match[1])) {
      return match[1];
    }
  }
  return '';
}

export function canonicalRedirectUrl(canonicalPath, origin = 'https://pokoin.com') {
  const path = String(canonicalPath || '').split(/[?#]/)[0];
  if (!path.startsWith('/marketplace/') || !path.includes('/cards/')) {
    return '';
  }
  return `${String(origin || 'https://pokoin.com').replace(/\/$/, '')}${path}`;
}

export function pathFromSlugMap(cardId, slugs) {
  const id = String(cardId || '');
  const slug = slugs && typeof slugs === 'object' ? String(slugs[id] || '') : '';
  if (!id || !slug) {
    return '';
  }
  return `/marketplace/en/cards/${id}/${slug}`;
}

/** Slug so the Worker does not intercept this URL again. SPA replace()s to canonical. */
export function placeholderCanonicalPath(cardId) {
  const id = String(cardId || '');
  if (!/^\d+$/.test(id)) {
    return '';
  }
  return `/marketplace/en/cards/${id}/card`;
}

export function u32View(bytes) {
  const raw = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const offset = bytes instanceof ArrayBuffer ? 0 : bytes.byteOffset;
  const length = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength;
  if (offset % 4 === 0) {
    return new Uint32Array(raw, offset, length / 4);
  }
  const copy = new Uint8Array(length);
  copy.set(new Uint8Array(raw, offset, length));
  return new Uint32Array(copy.buffer);
}

export function slugFromPackedIndex(cardId, ids, starts, blob) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0 || !ids?.length) {
    return '';
  }
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = ids[mid];
    if (value === id) {
      return String(blob).slice(starts[mid], starts[mid + 1]);
    }
    if (value < id) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return '';
}
