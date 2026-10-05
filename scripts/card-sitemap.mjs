/** Chunk canonical card URLs into sitemap files. Currency query URLs stay out. */

export const CARD_SITEMAP_CHUNK = 45000;
const CARD_PATH = /^\/marketplace\/[a-z]{2}(?:-[a-z]{2})?\/cards\/\d+(?:\/[^/?#]+)?\/?$/i;

export function canonicalCardPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'https://pokoin.com');
    url.search = '';
    url.hash = '';
    const path = url.pathname.replace(/\/$/, '');
    if (!CARD_PATH.test(path)) return '';
    return path;
  } catch {
    return '';
  }
}

export function chunkCardPaths(paths, size = CARD_SITEMAP_CHUNK) {
  const unique = [];
  const seen = new Set();
  for (const value of paths || []) {
    const path = canonicalCardPath(value);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  const chunks = [];
  for (let index = 0; index < unique.length; index += size) {
    chunks.push(unique.slice(index, index + size));
  }
  return chunks;
}

export function cardSitemapFileName(index) {
  return `sitemap-cards-${String(index + 1).padStart(3, '0')}.xml`;
}

export function existingCardSitemapNames(names = []) {
  return names.filter((name) => /^sitemap-cards-\d{3}\.xml$/.test(name)).sort();
}

export function renderUrlSet(paths, origin = 'https://pokoin.com') {
  const body = paths.map((path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
