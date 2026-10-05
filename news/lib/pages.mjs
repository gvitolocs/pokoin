// Page composition for Pokoin News: article, card, home, section, author, static, 404.
import { readFileSync } from 'node:fs';
import { attr, esc, safeUrl } from './html.mjs';
import { formatDate, sectionLabel } from './format.mjs';
import { computeReadingStats } from './schema.mjs';
import { renderArticleBody } from './article.mjs';
import { renderBlock } from './blocks.mjs';
import { renderPage } from './layout.mjs';
import {
  authorPageJsonLd,
  breadcrumbJsonLd,
  claimReviewJsonLd,
  newsArticleJsonLd,
  websiteJsonLd,
} from './jsonld.mjs';
import { relatedStories } from './related.mjs';
import { SITE, STATIC_PAGES } from './site.mjs';

const CONTENT_DIR = new URL('../content/', import.meta.url);
const contentCache = new Map();

function readContent(file) {
  if (!contentCache.has(file)) {
    contentCache.set(file, readFileSync(new URL(file, CONTENT_DIR), 'utf8'));
  }
  return contentCache.get(file);
}

function typeSlug(type) {
  return String(type || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function publishedSorted(all) {
  return (Array.isArray(all) ? all : [])
    .filter((record) => record && record.status === 'published')
    .slice()
    .sort((a, b) => new Date(b.datePublished || 0).getTime() - new Date(a.datePublished || 0).getTime());
}

// The largest hero variant no wider than 800 px, else the base hero.
function cardImage(hero) {
  if (!hero || !hero.url) return '';
  const variants = (hero.variants || []).filter(
    (variant) => variant && variant.url && Number.isFinite(variant.width) && variant.width <= 800,
  );
  let best = null;
  for (const variant of variants) if (!best || variant.width > best.width) best = variant;
  const src = best ? best.url : hero.url;
  const width = best ? best.width : hero.width;
  const height = best ? best.height : hero.height;
  return (
    `<img loading="lazy" decoding="async" src="${esc(safeUrl(src))}"` +
    `${attr('width', width)}${attr('height', height)} alt="${esc(hero.alt || '')}">`
  );
}

export function renderArticleCard(record, { size = 'm' } = {}) {
  const heading = size === 'lead' ? 'h2' : 'h3';
  const stats = computeReadingStats(record);
  const date = record.datePublished
    ? `<time datetime="${esc(record.datePublished)}">${esc(formatDate(record.datePublished))}</time>`
    : '';
  const dek = size === 'l' || size === 'm' ? `<p class="nx-card__dek">${esc(record.dek)}</p>` : '';
  return (
    `<article class="nx-card nx-card--${esc(size)}">` +
    cardImage(record.hero) +
    `<p class="nx-card__meta"><span class="nx-type nx-type--${esc(typeSlug(record.articleType))}">` +
    `${esc(record.articleType)}</span> ${esc(sectionLabel(record.section))}</p>` +
    `<${heading}><a href="/news/${esc(record.slug)}">${esc(record.headline)}</a></${heading}>` +
    dek +
    `<p class="nx-card__by">Poko · ${date} · ${stats.readingMinutes} min read</p>` +
    `</article>`
  );
}

function relatedAside(record, all, ctx) {
  const cards = (record.related && record.related.cards) || [];
  const sets = (record.related && record.related.sets) || [];
  const stories = relatedStories(record, all || []);
  const sections = [];
  if (cards.length) {
    sections.push(
      `<section class="nx-related__cards"><h2>Related cards</h2>` +
        cards.map((card) => renderBlock({ type: 'related_card', cardId: card.cardId }, record, ctx)).join('') +
        `</section>`,
    );
  }
  if (sets.length) {
    sections.push(
      `<section class="nx-related__sets"><h2>Explore set</h2>` +
        sets.map((set) => renderBlock({ type: 'related_set', slug: set.slug }, record, ctx)).join('') +
        `</section>`,
    );
  }
  if (stories.length) {
    sections.push(
      `<section class="nx-related__stories"><h2>Related stories</h2>` +
        stories.map((story) => renderArticleCard(story, { size: 'm' })).join('') +
        `</section>`,
    );
  }
  return sections.length ? `<aside class="nx-related">${sections.join('')}</aside>` : '';
}

export function renderArticlePage(record, all, ctx = {}) {
  const baseUrl = ctx.baseUrl || SITE.baseUrl;
  const hero = record.hero || ctx.fallbackHero || null;
  const image = hero ? { url: hero.url, width: hero.width, height: hero.height, alt: hero.alt } : null;
  const canonicalPath = `/news/${record.slug}`;

  const extraHead = [
    `<meta property="article:published_time" content="${esc(record.datePublished)}">`,
    record.dateModified
      ? `<meta property="article:modified_time" content="${esc(record.dateModified)}">`
      : '',
    `<meta property="article:section" content="${esc(sectionLabel(record.section))}">`,
    `<meta property="article:author" content="${esc(`${baseUrl}/news/authors/poko`)}">`,
    ...(record.tags || []).map((tag) => `<meta property="article:tag" content="${esc(tag)}">`),
  ].join('');

  const claimReview = claimReviewJsonLd(record, { baseUrl });
  const jsonLd = [
    newsArticleJsonLd(record, { baseUrl }),
    breadcrumbJsonLd(
      [
        { name: 'News', url: `${baseUrl}/news` },
        { name: sectionLabel(record.section), url: `${baseUrl}/news/${record.section}` },
        { name: record.headline, url: `${baseUrl}${canonicalPath}` },
      ],
      { baseUrl },
    ),
    ...(claimReview ? [claimReview] : []),
  ];

  const body = renderArticleBody(record, { ...ctx, baseUrl }) + relatedAside(record, all, ctx);

  return renderPage({
    title: `${record.headline} — Pokoin News`,
    description: record.dek,
    canonicalPath,
    ogType: 'article',
    image,
    jsonLd,
    body,
    activeNav: record.section,
    extraHead,
    preview: ctx.preview === true,
    assets: ctx.assets,
  });
}

const HOME_DESCRIPTION = 'Pokémon TCG news, fact checks and market data from Poko, Pokoin\'s AI-assisted news desk.';

export function renderHome(all, ctx = {}) {
  const baseUrl = ctx.baseUrl || SITE.baseUrl;
  const published = publishedSorted(all);
  const page = {
    canonicalPath: '/news',
    activeNav: 'latest',
    preview: ctx.preview === true,
    assets: ctx.assets,
  };

  if (!published.length) {
    const body =
      `<section class="nx-empty"><h1>Pokoin News</h1>` +
      `<p>Pokoin News is getting ready. The first stories are in editorial review.</p>` +
      `<p><a href="/news/about">About Pokoin News</a> · ` +
      `<a href="/news/editorial-policy">Editorial policy</a> · ` +
      `<a href="/news/methodology">Sources &amp; methodology</a></p></section>`;
    return renderPage({
      ...page,
      title: 'Pokoin News — Pokémon TCG news, fact checks and market data',
      description: HOME_DESCRIPTION,
      jsonLd: [websiteJsonLd()],
      body,
    });
  }

  const front =
    `<div class="nx-front">` +
    renderArticleCard(published[0], { size: 'lead' }) +
    published.slice(1, 5).map((record) => renderArticleCard(record, { size: 'm' })).join('') +
    `</div>`;

  const rest = published.slice(5);
  const rails = [
    { title: 'Latest', href: '/news', records: rest.slice(0, 8) },
    {
      title: 'Market Pulse',
      href: '/news/market',
      records: published.filter((record) => ['market_pulse', 'data_deep_dive'].includes(record.template)),
    },
    { title: 'Reveals', href: '/news/cards', records: published.filter((record) => record.template === 'reveal') },
    {
      title: 'Explainers',
      href: '/news/cards',
      records: published.filter((record) => ['explainer', 'comparison'].includes(record.template)),
    },
    {
      title: 'Fact Checks',
      href: '/news/fact-check',
      records: published.filter((record) => record.template === 'fact_check'),
    },
  ].filter((rail) => rail.records.length);

  const railsHtml = rails
    .map(
      (rail) =>
        `<section class="nx-rail"><h2>${esc(rail.title)}</h2>` +
        `<a class="nx-rail__more" href="${esc(rail.href)}">More</a>` +
        `<div class="nx-rail__items">${rail.records.map((record) => renderArticleCard(record, { size: 'm' })).join('')}</div>` +
        `</section>`,
    )
    .join('');

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: published.slice(0, 10).map((record, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: `${baseUrl}/news/${record.slug}`,
    })),
  };

  return renderPage({
    ...page,
    title: 'Pokoin News — Pokémon TCG news, fact checks and market data',
    description: HOME_DESCRIPTION,
    jsonLd: [websiteJsonLd(), itemList],
    body: front + railsHtml,
  });
}

export function renderSection(sectionId, all, ctx = {}) {
  const published = publishedSorted(all).filter(
    (record) =>
      record.section === sectionId ||
      (sectionId === 'fact-check' && record.template === 'fact_check') ||
      (sectionId === 'analysis' && record.template === 'analysis'),
  );
  const label = sectionLabel(sectionId) || sectionId;
  const list = published.length
    ? published.map((record) => renderArticleCard(record, { size: 'm' })).join('')
    : `<p class="nx-empty">No articles in ${esc(label)} yet.</p>`;
  const body = `<section class="nx-section"><h1>${esc(label)}</h1><div class="nx-list">${list}</div></section>`;
  return renderPage({
    title: `${label} — Pokoin News`,
    description: `Pokoin News coverage in ${label}.`,
    canonicalPath: `/news/${sectionId}`,
    body,
    activeNav: sectionId,
    preview: ctx.preview === true,
    assets: ctx.assets,
  });
}

export function renderAuthorPage(all, ctx = {}) {
  const latest = publishedSorted(all).slice(0, 20);
  const content = readContent('author-poko.html');
  const body =
    `<article class="nx-page nx-author"><h1>Poko — Pokoin News Desk</h1>` +
    content +
    `<section class="nx-author__latest"><h2>Latest from Poko</h2>` +
    `<div class="nx-list">${latest.map((record) => renderArticleCard(record, { size: 'm' })).join('')}</div>` +
    `</section></article>`;
  return renderPage({
    title: 'Poko — Pokoin News Desk',
    description: "Poko is Pokoin's AI-assisted Pokémon TCG reporter.",
    canonicalPath: '/news/authors/poko',
    jsonLd: [authorPageJsonLd()],
    body,
    activeNav: 'authors',
    preview: ctx.preview === true,
    assets: ctx.assets,
  });
}

export function renderStaticPage(page, ctx = {}) {
  const content = readContent(page.file);
  const body = `<article class="nx-page nx-page--${esc(page.slug)}"><h1>${esc(page.title)}</h1>${content}</article>`;
  return renderPage({
    title: `${page.title} — Pokoin News`,
    description: page.title,
    canonicalPath: `/news/${page.slug}`,
    body,
    activeNav: page.slug,
    preview: ctx.preview === true,
    assets: ctx.assets,
  });
}

export function renderNotFound(ctx = {}) {
  const body =
    `<section class="nx-notfound"><h1>Page not found</h1>` +
    `<p>The page you asked for is not here.</p>` +
    `<p><a href="/news">Back to Pokoin News</a></p></section>`;
  return renderPage({
    title: 'Page not found — Pokoin News',
    description: 'The page you asked for is not here.',
    canonicalPath: '/news/404',
    robots: 'noindex, nofollow',
    body,
    activeNav: 'latest',
    preview: ctx.preview === true,
    assets: ctx.assets,
  });
}

export { STATIC_PAGES, readContent };
