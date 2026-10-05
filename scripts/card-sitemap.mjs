/** Chunk canonical card URLs into sitemap files. Currency query URLs stay out. */

export const CARD_SITEMAP_CHUNK = 45000;
export const SHOPPING_FEED_CHUNK = 12000;
/** Pokemon stays unprefixed. Other TCGs live at /{slug}/marketplace/… */
const CARD_PATH = /^(\/[a-z0-9-]+)?\/marketplace\/[a-z]{2}(?:-[a-z]{2})?\/cards\/\d+(?:\/[^/?#]+)?\/?$/i;

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

/** Final image URL. pokoin.com/card-images redirects, and Google often drops that hop. */
export function crawlableCardImage(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'https://pokoin.com');
    if (url.hostname === 'pokoin.com' && url.pathname.startsWith('/card-images/')) {
      url.hostname = 'cdn.pokoin.com';
      url.pathname = url.pathname.slice('/card-images'.length) || '/';
    }
    if (url.protocol !== 'https:') return '';
    if (url.hostname !== 'cdn.pokoin.com' && url.hostname !== 'pokoin.com') return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function chunkCardPaths(paths, size = CARD_SITEMAP_CHUNK) {
  const unique = [];
  const seen = new Set();
  for (const value of paths || []) {
    const rawPath = typeof value === 'string' ? value : value?.path;
    const path = canonicalCardPath(rawPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const image = typeof value === 'string' ? '' : crawlableCardImage(value?.image);
    unique.push(image ? { path, image } : path);
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

export function gameCardPath(canonicalPath, slug = '') {
  const path = canonicalCardPath(canonicalPath);
  if (!path) return '';
  const prefix = String(slug || '').replace(/^\/+|\/+$/g, '');
  if (!prefix || path.startsWith(`/${prefix}/`)) return path;
  return `/${prefix}${path}`;
}

function xmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderUrlSet(paths, origin = 'https://pokoin.com') {
  const hasImage = (paths || []).some((page) => page && typeof page === 'object' && page.image);
  const xmlns = hasImage
    ? 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    : 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const body = (paths || []).map((page) => {
    const path = typeof page === 'string' ? page : page.path;
    const image = typeof page === 'string' ? '' : crawlableCardImage(page.image);
    const imageXml = image
      ? `\n    <image:image>\n      <image:loc>${xmlText(image)}</image:loc>\n    </image:image>`
      : '';
    return `  <url>\n    <loc>${xmlText(`${origin}${path}`)}</loc>${imageXml}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${xmlns}>\n${body}\n</urlset>\n`;
}

export function shoppingFeedFileName(currency, index) {
  return `google-shopping-${String(currency || '').toLowerCase()}-${String(index + 1).padStart(3, '0')}.xml`;
}

export function renderShoppingItem(item) {
  const lines = [
    '  <item>',
    `    <g:id>${xmlText(item.id)}</g:id>`,
    `    <g:title>${xmlText(item.title)}</g:title>`,
    `    <g:description>${xmlText(item.description)}</g:description>`,
    `    <g:link>${xmlText(item.link)}</g:link>`,
    `    <g:image_link>${xmlText(item.image)}</g:image_link>`,
    `    <g:availability>${xmlText(item.availability)}</g:availability>`,
    `    <g:price>${xmlText(item.price)} ${xmlText(item.currency)}</g:price>`,
    `    <g:brand>${xmlText(item.brand)}</g:brand>`,
    `    <g:condition>${xmlText(item.condition)}</g:condition>`,
    '    <g:identifier_exists>no</g:identifier_exists>',
    '    <g:google_product_category>Toys &amp; Games &gt; Games &gt; Card Games &gt; Collectible Card Games</g:google_product_category>',
    '  </item>',
  ];
  return lines.join('\n');
}

export function renderShoppingFeed(items, { title = 'Pokoin', origin = 'https://pokoin.com' } = {}) {
  const body = items.map((item) => renderShoppingItem(item)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n  <title>${xmlText(title)}</title>\n  <link>${xmlText(origin)}</link>\n  <description>Pokoin catalog. In stock is a Pokoin listing. Out of stock uses the market minimum.</description>\n${body}\n</channel>\n</rss>\n`;
}
