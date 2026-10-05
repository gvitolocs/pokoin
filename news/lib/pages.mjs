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
import { SITE, STATIC_PAGES, fallbackHero } from './site.mjs';
import { articlePath } from './schema.mjs';
import { sectionsFor } from './feeds.mjs';
import { gameOf, gameName, gameNewsBase, gameSwitcher, sectionHref } from './games.mjs';

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

export function renderArticleCard(record, { size = 'm', showGame = false } = {}) {
  const heading = size === 'lead' ? 'h2' : 'h3';
  const stats = computeReadingStats(record);
  const date = record.datePublished
    ? `<time datetime="${esc(record.datePublished)}">${esc(formatDate(record.datePublished))}</time>`
    : '';
  const dek = size === 'l' || size === 'm' ? `<p class="nx-card__dek">${esc(record.dek)}</p>` : '';
  return (
    `<article class="nx-card nx-card--${esc(size)}">` +
    cardImage(record.hero || fallbackHero(record.section)) +
    `<p class="nx-card__meta"><span class="nx-type nx-type--${esc(typeSlug(record.articleType))}">` +
    `${esc(record.articleType)}</span> ` +
    (showGame ? `<span class="nx-card__game">${esc(gameName(gameOf(record)))}</span> · ` : '') +
    `${esc(sectionLabel(record.section))}</p>` +
    `<${heading}><a href="${esc(articlePath(record))}">${esc(record.headline)}</a></${heading}>` +
    dek +
    `<p class="nx-card__by">Poko · ${date} · ${stats.readingMinutes} min read</p>` +
    `</article>`
  );
}

// Reader comments load client-side from the Pokoin API (moderated first);
// the article itself never depends on them.
function commentsSection(record) {
  return (
    `<section class="nx-comments" id="comments" aria-labelledby="nx-comments-h"` +
    ` data-article-id="${esc(record.id)}" data-article-path="${esc(articlePath(record))}" data-api="${esc(SITE.commentsApi)}">` +
    `<h2 id="nx-comments-h">Comments</h2>` +
    `<p class="nx-comments__note">Comments are moderated before they appear. Be kind, stay on topic, ` +
    `no selling or links to listings. Pokoin accounts only.</p>` +
    `<ol class="nx-comments__list" aria-live="polite"></ol>` +
    `<div class="nx-comments__form"></div>` +
    `<noscript><p class="nx-comments__note">Comments need JavaScript.</p></noscript>` +
    `</section>`
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
  const canonicalPath = articlePath(record);
  const game = gameOf(record);

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
        ...(game !== 'pokemon' ? [{ name: gameName(game), url: `${baseUrl}${gameNewsBase(game)}` }] : []),
        { name: sectionLabel(record.section), url: `${baseUrl}${sectionHref(game, record.section)}` },
        { name: record.headline, url: `${baseUrl}${canonicalPath}` },
      ],
      { baseUrl },
    ),
    ...(claimReview ? [claimReview] : []),
  ];

  const body = renderArticleBody(record, { ...ctx, baseUrl }) + commentsSection(record) + relatedAside(record, all, ctx);

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
    game,
    games: gameSwitcher(all),
    sections: navSections(game, all),
  });
}

// Other games only link sections that have stories (no empty pages).
function navSections(game, all) {
  return game === 'pokemon' ? null : sectionsFor(game, all);
}

const HOME_DESCRIPTION = 'Pokémon TCG news, fact checks and market data from Poko, Pokoin\'s AI-assisted news desk.';

function homeTitle(game) {
  return game === 'pokemon'
    ? 'Pokoin News — Pokémon TCG news, fact checks and market data'
    : `${gameName(game)} news — Pokoin News`;
}

function homeDescription(game) {
  return game === 'pokemon'
    ? HOME_DESCRIPTION
    : `${gameName(game)} news, fact checks and market data from Poko, Pokoin's AI-assisted news desk.`;
}

export function renderHome(all, ctx = {}) {
  const baseUrl = ctx.baseUrl || SITE.baseUrl;
  const game = ctx.game || 'pokemon';
  const base = gameNewsBase(game);
  const everything = publishedSorted(all);
  const published = everything.filter((record) => gameOf(record) === game);
  const page = {
    canonicalPath: base,
    activeNav: 'latest',
    preview: ctx.preview === true,
    assets: ctx.assets,
    game,
    games: gameSwitcher(all),
    sections: navSections(game, all),
  };

  if (!published.length) {
    const body =
      `<section class="nx-empty"><h1>${esc(game === 'pokemon' ? 'Pokoin News' : `${gameName(game)} news`)}</h1>` +
      `<p>${game === 'pokemon' ? 'Pokoin News is getting ready. The first stories are in editorial review.' : `No ${esc(gameName(game))} stories yet. Poko publishes when there is something worth reporting.`}</p>` +
      `<p><a href="/news/about">About Pokoin News</a> · ` +
      `<a href="/news/editorial-policy">Editorial policy</a> · ` +
      `<a href="/news/methodology">Sources &amp; methodology</a></p></section>`;
    return renderPage({
      ...page,
      title: homeTitle(game),
      description: homeDescription(game),
      jsonLd: [websiteJsonLd()],
      // An empty hub is a thin page: keep it out of the index until it has stories.
      robots: 'noindex, follow',
      body,
    });
  }

  const front =
    `<div class="nx-front">` +
    renderArticleCard(published[0], { size: 'lead' }) +
    published.slice(1, 5).map((record) => renderArticleCard(record, { size: 'm' })).join('') +
    `</div>`;

  const rest = published.slice(5);
  // Topical rails never repeat a story already on the front.
  const onFront = new Set(published.slice(0, 5).map((record) => record.id));
  const notOnFront = (record) => !onFront.has(record.id);
  const rails = [
    { title: 'Latest', href: base, records: rest.slice(0, 8) },
    {
      title: 'Market Pulse',
      href: `${base}/market`,
      records: published.filter(notOnFront).filter((record) => ['market_pulse', 'data_deep_dive'].includes(record.template)),
    },
    { title: 'Reveals', href: `${base}/cards`, records: published.filter(notOnFront).filter((record) => record.template === 'reveal') },
    {
      title: 'Explainers',
      href: `${base}/cards`,
      records: published.filter(notOnFront).filter((record) => ['explainer', 'comparison'].includes(record.template)),
    },
    {
      title: 'Fact Checks',
      href: `${base}/fact-check`,
      records: published.filter(notOnFront).filter((record) => record.template === 'fact_check'),
    },
    // Pokémon front page: latest from the other games, each linking to its own hub.
    ...(game === 'pokemon'
      ? [{ title: 'Across the TCGs', href: null, showGame: true, records: everything.filter((record) => gameOf(record) !== 'pokemon').slice(0, 8) }]
      : []),
  ].filter((rail) => rail.records.length);

  const railsHtml = rails
    .map(
      (rail) =>
        `<section class="nx-rail"><h2>${esc(rail.title)}</h2>` +
        (rail.href ? `<a class="nx-rail__more" href="${esc(rail.href)}">More</a>` : '') +
        `<div class="nx-rail__items">${rail.records.map((record) => renderArticleCard(record, { size: 'm', showGame: rail.showGame === true })).join('')}</div>` +
        `</section>`,
    )
    .join('');

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: published.slice(0, 10).map((record, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: `${baseUrl}${articlePath(record)}`,
    })),
  };

  return renderPage({
    ...page,
    title: homeTitle(game),
    description: homeDescription(game),
    jsonLd: [websiteJsonLd(), itemList],
    body: front + railsHtml,
  });
}

export function renderSection(sectionId, all, ctx = {}) {
  const game = ctx.game || 'pokemon';
  const published = publishedSorted(all).filter((record) => gameOf(record) === game).filter(
    (record) =>
      record.section === sectionId ||
      (sectionId === 'fact-check' && record.template === 'fact_check') ||
      (sectionId === 'analysis' && record.template === 'analysis'),
  );
  const label = sectionLabel(sectionId) || sectionId;
  const list = published.length
    ? published.map((record) => renderArticleCard(record, { size: 'm' })).join('')
    : `<p class="nx-empty">No articles in ${esc(label)} yet.</p>`;
  const heading = game === 'pokemon' ? label : `${gameName(game)}: ${label}`;
  const body = `<section class="nx-section"><h1>${esc(heading)}</h1><div class="nx-list">${list}</div></section>`;
  return renderPage({
    title: `${heading} — Pokoin News`,
    description: `Pokoin News ${game === 'pokemon' ? '' : `${gameName(game)} `}coverage in ${label}.`,
    canonicalPath: sectionHref(game, sectionId),
    body,
    activeNav: sectionId,
    preview: ctx.preview === true,
    assets: ctx.assets,
    game,
    games: gameSwitcher(all),
    sections: navSections(game, all),
  });
}

export function renderAuthorPage(all, ctx = {}) {
  const latest = publishedSorted(all).slice(0, 20);
  const content = readContent('author-poko.html');
  const body =
    `<article class="nx-page nx-author"><h1>Poko — Pokoin News Desk</h1>` +
    content +
    `<section class="nx-author__latest"><h2>Latest from Poko</h2>` +
    `<div class="nx-list">${latest.map((record) => renderArticleCard(record, { size: 'm', showGame: true })).join('')}</div>` +
    `</section></article>`;
  return renderPage({
    title: 'Poko — Pokoin News Desk',
    description: "Poko is Pokoin's AI-assisted trading card game reporter.",
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

export { STATIC_PAGES, readContent, sectionsFor };
