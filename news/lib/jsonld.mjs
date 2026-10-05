// schema.org JSON-LD builders for Pokoin News.
import { sectionLabel } from './format.mjs';
import { computeReadingStats } from './schema.mjs';
import { SITE } from './site.mjs';

function toAbsolute(url, base = SITE.baseUrl) {
  if (!url) return '';
  const value = String(url);
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${base}${value}`;
  return `${base}/${value}`;
}

function publisherOrganization() {
  return {
    '@type': 'Organization',
    name: SITE.publisher.name,
    url: SITE.publisher.url,
    logo: {
      '@type': 'ImageObject',
      url: SITE.logoUrl,
      width: SITE.logoWidth,
      height: SITE.logoHeight,
    },
  };
}

// Hero image URLs in the order 1x1, 4x3, 16x9 then the base hero, deduped.
function articleImageUrls(hero, base) {
  if (!hero) return [];
  const urls = [];
  const push = (url) => {
    const absolute = toAbsolute(url, base);
    if (absolute && !urls.includes(absolute)) urls.push(absolute);
  };
  for (const ratio of ['1x1', '4x3', '16x9']) {
    const variant = (hero.variants || []).find((entry) => entry && entry.ratio === ratio);
    if (variant) push(variant.url);
  }
  push(hero.url);
  return urls;
}

function aboutEntities(record, base) {
  return (record.entities || [])
    .filter((entity) => entity && entity.resolved && entity.path)
    .map((entity) => ({ '@type': 'Thing', name: entity.name, url: toAbsolute(entity.path, base) }));
}

export function newsArticleJsonLd(record, { baseUrl } = {}) {
  const base = baseUrl || SITE.baseUrl;
  const canonical = `${base}/news/${record.slug}`;
  const stats = computeReadingStats(record);
  const type = record.template === 'analysis' ? ['NewsArticle', 'AnalysisNewsArticle'] : 'NewsArticle';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': type,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    url: canonical,
    headline: record.headline,
    description: record.dek,
    datePublished: record.datePublished,
    dateModified: record.dateModified,
    author: [
      {
        '@type': 'Organization',
        name: 'Poko — Pokoin News Desk',
        url: `${base}/news/authors/poko`,
      },
    ],
    publisher: publisherOrganization(),
    articleSection: sectionLabel(record.section),
    inLanguage: 'en',
    keywords: (record.tags || []).join(', '),
    isAccessibleForFree: true,
    wordCount: stats.wordCount,
    about: aboutEntities(record, base),
  };

  const images = articleImageUrls(record.hero, base);
  if (images.length) jsonLd.image = images;
  return jsonLd;
}

// ClaimReview is only emitted for a CONFIRMED or FALSE verdict on a fact_check
// article carrying exactly one fact_check block.
export function claimReviewJsonLd(record, { baseUrl } = {}) {
  const base = baseUrl || SITE.baseUrl;
  const factChecks = (record.blocks || []).filter((block) => block && block.type === 'fact_check');
  if (record.template !== 'fact_check' || factChecks.length !== 1) return null;
  const block = factChecks[0];
  const ratingValue = block.verdict === 'CONFIRMED' ? 5 : block.verdict === 'FALSE' ? 1 : null;
  if (ratingValue === null) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ClaimReview',
    url: `${base}/news/${record.slug}`,
    claimReviewed: block.claim,
    reviewRating: {
      '@type': 'Rating',
      ratingValue,
      bestRating: 5,
      worstRating: 1,
      alternateName: block.verdict,
    },
    author: { '@type': 'Organization', name: SITE.publisher.name, url: SITE.publisher.url },
  };
}

export function breadcrumbJsonLd(items, { baseUrl } = {}) {
  const base = baseUrl || SITE.baseUrl;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items || []).map((item, index) => {
      const entry = typeof item === 'string' ? { name: item } : item || {};
      const entryUrl = toAbsolute(entry.url || entry.path || '', base);
      const listItem = { '@type': 'ListItem', position: index + 1, name: entry.name };
      if (entryUrl) listItem.item = entryUrl;
      return listItem;
    }),
  };
}

export function websiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.publicationName,
    url: `${SITE.baseUrl}/news`,
    inLanguage: SITE.language,
    publisher: publisherOrganization(),
  };
}

export function authorPageJsonLd() {
  const url = `${SITE.baseUrl}/news/authors/poko`;
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    name: 'Poko — Pokoin News Desk',
    mainEntity: {
      '@type': 'Organization',
      name: 'Poko — Pokoin News Desk',
      url,
      description:
        "Poko is Pokoin's AI-assisted Pokémon TCG reporter. Every article is assembled from cited sources and labelled as AI-assisted.",
    },
  };
}
