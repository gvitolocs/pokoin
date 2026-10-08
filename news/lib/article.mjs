// Article body renderer: the <article> element only (page layout/head is W2).
import { gameOf, gameName, gameNewsBase, sectionHref } from './games.mjs';
import { esc, attr, safeUrl } from './html.mjs';
import { formatDateTime, formatTime, sectionLabel } from './format.mjs';
import { POKO_AUTHOR, computeReadingStats, articlePath } from './schema.mjs';
import { renderBlocks } from './blocks.mjs';

const UPDATED_THRESHOLD_MS = 60 * 1000;

function typeSlug(type) {
  return String(type || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The best hero source: the widest variant at least 1200 px wide, else hero.url.
function bestHeroVariant(hero) {
  const variants = (Array.isArray(hero.variants) ? hero.variants : []).filter(
    (variant) => variant && variant.url && Number.isFinite(variant.width) && variant.width >= 1200,
  );
  let best = null;
  for (const variant of variants) if (!best || variant.width > best.width) best = variant;
  return best;
}

function renderHero(hero) {
  if (!hero) return '';
  const best = bestHeroVariant(hero);
  const src = best ? best.url : hero.url;
  const width = best && Number.isFinite(best.width) ? best.width : hero.width;
  const height = best && Number.isFinite(best.height) ? best.height : hero.height;

  const seen = new Set();
  const srcset = [...(Array.isArray(hero.variants) ? hero.variants : []), hero]
    .filter((entry) => {
      if (!entry || !entry.url || !Number.isFinite(entry.width) || seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    })
    .map((entry) => `${esc(safeUrl(entry.url))} ${entry.width}w`)
    .join(', ');

  const caption = hero.caption ? esc(hero.caption) : '';
  const credit = hero.credit ? `<span class="nx-credit">${esc(hero.credit)}</span>` : '';
  const figcaption = caption || credit ? `<figcaption>${caption}${caption && credit ? ' ' : ''}${credit}</figcaption>` : '';

  return (
    `<figure class="nx-hero">` +
    `<img src="${esc(safeUrl(src))}"${attr('srcset', srcset)} sizes="(max-width: 760px) 100vw, 760px"` +
    `${attr('width', width)}${attr('height', height)} fetchpriority="high" decoding="async" alt="${esc(hero.alt)}">` +
    figcaption +
    `</figure>`
  );
}

function renderUpdate(update) {
  return (
    `<p class="nx-update"><strong>Update — ${esc(formatTime(update.at))} UTC</strong> ` +
    `${esc(update.text)}</p>`
  );
}

function renderSources(record) {
  const items = (record.sources || [])
    .map((source) => {
      const tags = [];
      if (source.role === 'primary') tags.push('<span class="nx-source__tag">Primary source</span>');
      if (source.firstReported) tags.push('<span class="nx-source__tag">First reported</span>');
      return (
        `<li id="src-${esc(source.id)}"><strong>${esc(source.outlet)}</strong> — ` +
        `<a href="${esc(safeUrl(source.url))}" rel="noopener" target="_blank">${esc(source.title)}</a>` +
        `${tags.length ? ` ${tags.join(' ')}` : ''}</li>`
      );
    })
    .join('');
  return (
    `<section class="nx-sources" aria-labelledby="nx-sources-h">` +
    `<h2 id="nx-sources-h">Sources</h2><ol>${items}</ol></section>`
  );
}

function renderCorrections(record) {
  const corrections = Array.isArray(record.corrections) ? record.corrections : [];
  if (!corrections.length) return '';
  const items = corrections
    .map(
      (correction) =>
        `<p><strong>Correction — ${esc(formatDateTime(correction.at))}</strong> ` +
        `${esc(correction.previous)} ${esc(correction.corrected)}</p>`,
    )
    .join('');
  return `<section class="nx-corrections"><h2>Corrections</h2>${items}</section>`;
}

function renderDisclosure(record) {
  const relatedCards = record.related && Array.isArray(record.related.cards) ? record.related.cards : [];
  const marketplaceLine =
    record.market || relatedCards.length
      ? `<p>Pokoin News is published by Pokoin, which also operates the Pokoin marketplace whose data appears in this article.</p>`
      : '';
  return (
    `<aside class="nx-disclosure"><h2>About this article</h2>` +
    `<p>Poko is Pokoin's AI-assisted trading card game reporter. This article was assembled from the cited ` +
    `sources, compared across outlets and checked against the evidence before publication.</p>` +
    marketplaceLine +
    `<p><a href="/news/editorial-policy">Editorial policy</a> · ` +
    `<a href="/news/corrections">Corrections policy</a></p></aside>`
  );
}

function renderShare(record, url) {
  const text = record.headline || '';
  const xHref = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const telegramHref = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  return (
    `<div class="nx-share">` +
    `<a class="nx-share__x" href="${esc(xHref)}" rel="noopener" target="_blank">Share on X</a>` +
    `<a class="nx-share__telegram" href="${esc(telegramHref)}" rel="noopener" target="_blank">Share on Telegram</a>` +
    `<button type="button" class="nx-share__copy" data-url="${esc(url)}">Copy link</button>` +
    `</div>`
  );
}

export function renderArticleBody(record, ctx = {}) {
  const baseUrl = ctx.baseUrl || 'https://pokoin.com';
  const url = `${baseUrl}${articlePath(record)}`;
  const game = gameOf(record);
  const { readingMinutes } = computeReadingStats(record);
  const hero = record.hero || ctx.fallbackHero || null;

  const crumbs =
    `<nav class="nx-crumbs" aria-label="Breadcrumb"><ol>` +
    `<li><a href="/news">News</a></li>` +
    (game !== 'pokemon' ? `<li><a href="${esc(gameNewsBase(game))}">${esc(gameName(game))}</a></li>` : '') +
    `<li><a href="${esc(sectionHref(game, record.section))}">${esc(sectionLabel(record.section))}</a></li>` +
    `</ol></nav>`;

  const kicker =
    `<p class="nx-kicker"><span class="nx-type nx-type--${esc(typeSlug(record.articleType))}">` +
    `${esc(record.articleType)}</span></p>`;

  const published = record.datePublished ? new Date(record.datePublished) : null;
  const modified = record.dateModified ? new Date(record.dateModified) : null;
  let dates = '';
  if (published && !Number.isNaN(published.getTime())) {
    dates = `Published <time datetime="${esc(record.datePublished)}">${esc(formatDateTime(record.datePublished))}</time>`;
    if (
      modified &&
      !Number.isNaN(modified.getTime()) &&
      modified.getTime() - published.getTime() > UPDATED_THRESHOLD_MS
    ) {
      dates += ` · Updated <time datetime="${esc(record.dateModified)}">${esc(formatDateTime(record.dateModified))}</time>`;
    }
  }

  const byline =
    `<div class="nx-byline">` +
    `<span>By <a rel="author" href="${esc(POKO_AUTHOR.url)}">${esc(POKO_AUTHOR.name)} — ${esc(POKO_AUTHOR.role)}</a></span>` +
    `<span class="nx-byline__ai">AI-assisted reporting</span>` +
    `${dates ? `<span class="nx-dates">${dates}</span>` : ''}` +
    `<span class="nx-read">${readingMinutes} min read</span>` +
    `</div>`;

  const header =
    `<header class="nx-article__head">${crumbs}${kicker}` +
    `<h1 class="nx-h1">${esc(record.headline)}</h1>` +
    `<p class="nx-dek">${esc(record.dek)}</p>${byline}</header>`;

  const updates = (Array.isArray(record.updates) ? record.updates : [])
    .filter((update) => update && update.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const updatesHtml = updates.length
    ? `<div class="nx-updates">${updates.map(renderUpdate).join('')}</div>`
    : '';

  const body = `<div class="nx-body">${renderBlocks(record, ctx)}</div>`;

  return (
    `<article class="nx-article nx-t-${esc(record.template)}" data-type="${esc(record.articleType)}"` +
    ` data-article-id="${esc(record.id)}" data-article-path="${esc(articlePath(record))}">` +
    header +
    renderHero(hero) +
    updatesHtml +
    body +
    renderSources(record) +
    renderCorrections(record) +
    renderDisclosure(record) +
    renderShare(record, url) +
    `</article>`
  );
}
