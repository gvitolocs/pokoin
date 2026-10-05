// Full HTML document shell for every Pokoin News page.
import { esc } from './html.mjs';
import { sectionNav } from './format.mjs';
import { SITE } from './site.mjs';
import { gameName, gameNewsBase, gameMarketplaceBase } from './games.mjs';

const DEFAULT_ROBOTS =
  'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

const FOOTER_NEWS_LINKS = [
  { label: 'About', href: '/news/about' },
  { label: 'Editorial policy', href: '/news/editorial-policy' },
  { label: 'Corrections', href: '/news/corrections' },
  { label: 'Sources & methodology', href: '/news/methodology' },
  { label: 'Contact', href: '/news/contact' },
  { label: 'Poko — our AI reporter', href: '/news/authors/poko' },
  { label: 'RSS', href: '/news/rss.xml' },
];

const FOOTER_POKOIN_LINKS = [
  { label: 'Marketplace', href: '/marketplace' },
  { label: 'About Pokoin', href: '/about' },
  { label: 'Privacy', href: '/privacy' },
];

// Turn a site-relative path into an absolute URL.
export function absoluteUrl(url) {
  if (!url) return '';
  const value = String(url);
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${SITE.baseUrl}${value}`;
  return `${SITE.baseUrl}/${value}`;
}

function meta(name, content) {
  if (content === undefined || content === null || content === '') return '';
  return `<meta name="${esc(name)}" content="${esc(content)}">`;
}

function property(name, content) {
  if (content === undefined || content === null || content === '') return '';
  return `<meta property="${esc(name)}" content="${esc(content)}">`;
}

function linkList(links) {
  return `<ul>${links
    .map((link) => `<li><a href="${esc(link.href)}">${esc(link.label)}</a></li>`)
    .join('')}</ul>`;
}

export function renderPage({
  title,
  description,
  canonicalPath,
  ogType = 'website',
  image,
  jsonLd = [],
  robots,
  body,
  activeNav,
  preview = false,
  extraHead = '',
  assets,
  game = 'pokemon',
  games = [],
} = {}) {
  const base = gameNewsBase(game);
  const css = (assets && assets.css) || '/news/assets/news.css';
  const js = (assets && assets.js) || '/news/assets/news.js';
  const canonical = absoluteUrl(canonicalPath);
  const robotsContent = preview ? 'noindex, nofollow' : robots || DEFAULT_ROBOTS;
  const ogImage = image && image.url ? absoluteUrl(image.url) : '';

  const structuredData = (Array.isArray(jsonLd) ? jsonLd : [jsonLd])
    .filter(Boolean)
    .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`)
    .join('');

  const head =
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(title)}</title>` +
    meta('description', description) +
    `<link rel="canonical" href="${esc(canonical)}">` +
    meta('robots', robotsContent) +
    `<link rel="alternate" type="application/rss+xml" title="${esc(game === 'pokemon' ? 'Pokoin News' : `Pokoin News — ${gameName(game)}`)}" href="${esc(`${base}/rss.xml`)}">` +
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">' +
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
    `<link rel="preload" href="${esc(SITE.fontUrl)}" as="font" type="font/woff2" crossorigin>` +
    `<link rel="stylesheet" href="${esc(css)}">` +
    `<script src="${esc(js)}" defer></script>` +
    property('og:site_name', SITE.publicationName) +
    property('og:type', ogType) +
    property('og:title', title) +
    property('og:description', description) +
    property('og:url', canonical) +
    property('og:image', ogImage) +
    property('og:image:width', ogImage && image.width) +
    property('og:image:height', ogImage && image.height) +
    property('og:image:alt', ogImage && image.alt) +
    meta('twitter:card', 'summary_large_image') +
    meta('twitter:title', title) +
    meta('twitter:description', description) +
    meta('twitter:image', ogImage) +
    extraHead +
    structuredData;

  const switcher = games.length
    ? `<nav class="nx-games" aria-label="Games"><ul>${games.map(
      (entry) => `<li><a href="${esc(entry.href)}"${entry.id === game ? ' aria-current="true"' : ''}>${esc(entry.name)}</a></li>`,
    ).join('')}</ul></nav>`
    : '';
  const nav = `<nav class="nx-nav" aria-label="Sections"><ul>${sectionNav(base).map(
    (item) =>
      `<li><a href="${esc(item.href)}"${item.id === activeNav ? ' aria-current="page"' : ''}>${esc(item.label)}</a></li>`,
  ).join('')}</ul></nav>`;

  const banner = preview ? '<div class="nx-preview-banner">PREVIEW — not public</div>' : '';

  const header =
    `<header class="nx-top">` +
    `<a class="nx-logo" href="/"><img src="/home/logo.png" width="28" height="28" alt="Pokoin"></a>` +
    `<a class="nx-mast" href="/news">Pokoin <span>News</span></a>` +
    (game !== 'pokemon' ? `<a class="nx-mast__game" href="${esc(base)}">${esc(gameName(game))}</a>` : '') +
    `<a class="nx-market-link" href="${esc(gameMarketplaceBase(game))}">Marketplace</a>` +
    `</header>` +
    switcher +
    nav;

  const legalBits = [];
  if (SITE.publisher.legalName) legalBits.push(esc(SITE.publisher.legalName));
  if (SITE.publisher.address) legalBits.push(esc(SITE.publisher.address));
  const legal = legalBits.length ? ` ${legalBits.join(' · ')}` : '';

  const footer =
    `<footer class="nx-foot">` +
    `<div class="nx-foot__col"><h2>Pokoin News</h2>${linkList(FOOTER_NEWS_LINKS)}</div>` +
    `<div class="nx-foot__col"><h2>Pokoin</h2>${linkList(FOOTER_POKOIN_LINKS)}</div>` +
    `<p class="nx-foot__publisher">Pokoin News is published by Pokoin, which also operates the Pokoin ` +
    `marketplace. Contact: <a href="mailto:${esc(SITE.publisher.email)}">${esc(SITE.publisher.email)}</a>${legal}</p>` +
    `</footer>`;

  return (
    `<!doctype html><html lang="${esc(SITE.language)}"><head>${head}</head><body>` +
    `<a class="nx-skip" href="#main">Skip to content</a>` +
    banner +
    header +
    `<main id="main">${body || ''}</main>` +
    footer +
    `</body></html>`
  );
}
