/** Artist URL slug ↔ display name. Desk first paint uses the slug; the API can refine it. */

export function artistSlug(name) {
  return String(name || '')
    .replace(/é/g, 'e')
    .replace(/É/g, 'E')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Title-case the URL slug so refresh never paints `tomokazu-komiya`. */
export function artistNameFromSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Unknown slug after the artist API returns no illustrator and no cards. */
export function artistDeskIsUnknown(payload) {
  if (!payload) return false;
  const cards = payload.cards || [];
  return !payload.artist && cards.length === 0;
}
