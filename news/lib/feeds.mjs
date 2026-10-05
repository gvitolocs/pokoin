// Feeds and sitemaps for Pokoin News: Google News sitemap, URL sitemap, RSS 2.0.
import { esc } from './html.mjs';
import { rfc822, sectionLabel } from './format.mjs';
import { SECTIONS } from './schema.mjs';
import { SITE, STATIC_PAGES } from './site.mjs';

const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;

function isoZ(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function publishedRecords(all) {
  return (Array.isArray(all) ? all : [])
    .filter((record) => record && record.status === 'published' && record.datePublished)
    .slice()
    .sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
}

// Google News sitemap: published stories from the last 48 hours, newest first.
export function newsSitemap(all, { now = new Date(), baseUrl = SITE.baseUrl } = {}) {
  const nowMs = new Date(now).getTime();
  const items = publishedRecords(all)
    .filter((record) => {
      const at = new Date(record.datePublished).getTime();
      return Number.isFinite(at) && at <= nowMs && nowMs - at <= NEWS_WINDOW_MS;
    })
    .slice(0, 1000)
    .map(
      (record) =>
        `  <url><loc>${esc(`${baseUrl}/news/${record.slug}`)}</loc>\n` +
        `    <news:news><news:publication><news:name>${esc(SITE.publicationName)}</news:name>` +
        `<news:language>${esc(SITE.language)}</news:language></news:publication>\n` +
        `      <news:publication_date>${esc(isoZ(record.datePublished))}</news:publication_date>` +
        `<news:title>${esc(record.headline)}</news:title></news:news></url>`,
    )
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n' +
    (items ? `${items}\n` : '') +
    '</urlset>\n'
  );
}

function urlEntry(loc, lastmod) {
  return `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${esc(lastmod)}</lastmod>` : ''}</url>`;
}

// Standard sitemap: every published article plus the fixed news surfaces.
export function newsUrlSitemap(all, { baseUrl = SITE.baseUrl, now = new Date() } = {}) {
  const entries = publishedRecords(all).map((record) =>
    urlEntry(`${baseUrl}/news/${record.slug}`, record.dateModified ? isoZ(record.dateModified) : ''),
  );
  entries.push(urlEntry(`${baseUrl}/news`, isoZ(now)));
  for (const section of SECTIONS) entries.push(urlEntry(`${baseUrl}/news/${section}`, ''));
  entries.push(urlEntry(`${baseUrl}/news/authors/poko`, ''));
  for (const page of STATIC_PAGES) entries.push(urlEntry(`${baseUrl}/news/${page.slug}`, ''));

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${entries.join('\n')}\n` +
    '</urlset>\n'
  );
}

// RSS 2.0 feed of the latest 30 published stories.
export function rssFeed(all, { baseUrl = SITE.baseUrl, now = new Date() } = {}) {
  const records = publishedRecords(all).slice(0, 30);
  const lastBuildDate = records.length
    ? rfc822(records[0].datePublished)
    : rfc822(new Date(now).toISOString());

  const items = records
    .map((record) => {
      const url = `${baseUrl}/news/${record.slug}`;
      return (
        `    <item>\n` +
        `      <title>${esc(record.headline)}</title>\n` +
        `      <link>${esc(url)}</link>\n` +
        `      <guid isPermaLink="true">${esc(url)}</guid>\n` +
        `      <pubDate>${esc(rfc822(record.datePublished))}</pubDate>\n` +
        `      <dc:creator>${esc('Poko — Pokoin News Desk')}</dc:creator>\n` +
        `      <category>${esc(sectionLabel(record.section))}</category>\n` +
        `      <description>${esc(record.dek)}</description>\n` +
        `    </item>`
      );
    })
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    `  <channel>\n` +
    `    <title>${esc(SITE.publicationName)}</title>\n` +
    `    <link>${esc(`${baseUrl}/news`)}</link>\n` +
    `    <description>Pokémon TCG news, fact checks and market data from Poko, Pokoin's AI-assisted news desk.</description>\n` +
    `    <language>${esc(SITE.language)}</language>\n` +
    `    <atom:link href="${esc(`${baseUrl}/news/rss.xml`)}" rel="self" type="application/rss+xml"/>\n` +
    `    <lastBuildDate>${esc(lastBuildDate)}</lastBuildDate>\n` +
    (items ? `${items}\n` : '') +
    `  </channel>\n` +
    `</rss>\n`
  );
}
