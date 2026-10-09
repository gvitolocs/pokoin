import { crawlableCardImage } from './google-commerce.js';

function upsertMeta(selector, attrs, content) {
  if (typeof document === 'undefined') {
    return;
  }
  let el = document.head.querySelector(selector);
  if (!content) {
    if (el && el.getAttribute('data-pokoin-seo') === '1') {
      el.remove();
    }
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    el.setAttribute('data-pokoin-seo', '1');
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertLink(rel, href) {
  if (typeof document === 'undefined') {
    return;
  }
  const selector = `link[rel="${rel}"][data-pokoin-seo="1"]`;
  let el = document.head.querySelector(selector);
  if (!href) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    el.setAttribute('data-pokoin-seo', '1');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

function upsertJsonLd(blocks) {
  if (typeof document === 'undefined') {
    return;
  }
  const existing = document.getElementById('pokoin-jsonld');
  const list = (blocks || []).filter(Boolean);
  if (!list.length) {
    existing?.remove();
    return;
  }
  const el = existing || document.createElement('script');
  el.id = 'pokoin-jsonld';
  el.type = 'application/ld+json';
  el.textContent = JSON.stringify(list.length === 1 ? list[0] : list);
  if (!existing) {
    document.head.appendChild(el);
  }
}

/**
 * Write the page title, description, robots, canonical, Open Graph / Twitter
 * tags and JSON-LD into <head>. Framework-free: React SeoHead and the Solid
 * SeoHead both call it. Returns a restore function for the previous title.
 */
export function applySeoHead({
  title,
  description,
  canonical,
  noindex = false,
  image,
  imageAlt,
  jsonLd,
} = {}) {
  const prevTitle = document.title;
  if (title) {
    document.title = title;
  }
  upsertMeta('meta[name="description"]', { name: 'description' }, description || '');
  upsertMeta(
    'meta[name="robots"]',
    { name: 'robots' },
    noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large',
  );
  const origin = window.location.origin;
  const url = canonical
    ? (canonical.startsWith('http') ? canonical : `${origin}${canonical}`)
    : `${origin}${window.location.pathname}`;
  upsertLink('canonical', url);
  upsertMeta('meta[property="og:title"]', { property: 'og:title' }, title || '');
  upsertMeta('meta[property="og:description"]', { property: 'og:description' }, description || '');
  upsertMeta('meta[property="og:url"]', { property: 'og:url' }, url);
  upsertMeta('meta[property="og:type"]', { property: 'og:type' }, 'website');
  upsertMeta('meta[property="og:site_name"]', { property: 'og:site_name' }, 'Pokoin');
  const scan = crawlableCardImage(image, origin);
  upsertMeta('meta[property="og:image"]', { property: 'og:image' }, scan);
  upsertMeta('meta[property="og:image:alt"]', { property: 'og:image:alt' }, scan ? (imageAlt || title || '') : '');
  upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card' }, scan ? 'summary_large_image' : 'summary');
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title' }, title || '');
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description' }, description || '');
  upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image' }, scan);
  const parsed = jsonLd || null;
  upsertJsonLd(Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []));
  return () => {
    document.title = prevTitle;
  };
}
