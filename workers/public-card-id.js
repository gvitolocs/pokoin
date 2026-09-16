/** Storm Emeralda briefly used 999000000 + (ct_id × 2). Desk is leftover × 2. */

export const PROVISIONAL_PUBLIC_OFFSET = 999000000;

export function realPublicCardId(cardId) {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) {
    return id;
  }
  const value = Number(id);
  if (value >= PROVISIONAL_PUBLIC_OFFSET) {
    return String(value - PROVISIONAL_PUBLIC_OFFSET);
  }
  return id;
}

export function provisionalPublicCardId(cardId) {
  const real = realPublicCardId(cardId);
  if (!/^\d+$/.test(real)) {
    return real;
  }
  return String(Number(real) + PROVISIONAL_PUBLIC_OFFSET);
}

/** Query both leftover × 2 and the old 999 stamp so stale tile rows still hit. */
export function expandProvisionalCardIds(ids, max = 48) {
  const seen = new Set();
  const out = [];
  for (const raw of ids || []) {
    const real = realPublicCardId(String(raw || '').trim());
    if (!/^\d+$/.test(real)) {
      continue;
    }
    for (const id of [real, provisionalPublicCardId(real)]) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
      if (out.length >= max) {
        return out;
      }
    }
  }
  return out;
}

/** Leftover dump id: public card id / 2. Desk paths stay public; image keys do not. */
export function leftoverCdnId(cardId) {
  const id = realPublicCardId(cardId);
  if (!/^\d+$/.test(id)) {
    return '';
  }
  try {
    const value = BigInt(id);
    if (value <= 0n) {
      return '';
    }
    if (value % 2n === 0n) {
      return String(value / 2n);
    }
    return id;
  } catch {
    return '';
  }
}

export function rewriteLeftoverCatalogImage(url, cardId) {
  const leftover = leftoverCdnId(cardId);
  const text = String(url || '');
  if (!leftover || !text) {
    return text;
  }
  if (/(?:^|\/)(one-piece|riftbound|competitive)\//i.test(text)) {
    return text;
  }
  return text.replace(/(^|\/)(previews\/)?(\d+)_/, `$1$2${leftover}_`);
}

export function rewriteCanonicalCardPath(path, cardId, lang = 'en') {
  const id = realPublicCardId(cardId);
  const raw = String(path || '').trim();
  if (!/^\d+$/.test(id)) {
    return raw;
  }
  if (/\/cards\/\d+/.test(raw)) {
    return raw.replace(/\/cards\/\d+/, `/cards/${id}`);
  }
  if (raw) {
    return raw;
  }
  return `/marketplace/${String(lang || 'en').toLowerCase()}/cards/${id}`;
}
