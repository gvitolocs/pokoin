// Page, SEO, related-story and feed tests for the Pokoin News renderer (task W2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { esc } from '../lib/html.mjs';
import { articlePath } from '../lib/schema.mjs';
import { newsSitemap, newsUrlSitemap, rssFeed } from '../lib/feeds.mjs';
import { relatedStories } from '../lib/related.mjs';
import { renderArticlePage, renderHome, renderNotFound, renderStaticPage } from '../lib/pages.mjs';
import { STATIC_PAGES, SITE } from '../lib/site.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'sample-articles.json'), 'utf8'));
const baseUrl = 'https://pokoin.com';
const ctx = { baseUrl };
const clone = (record) => JSON.parse(JSON.stringify(record));
const byTemplate = (template) => fixtures.find((record) => record.template === template);
const publishedFixtures = fixtures.filter((record) => record.status === 'published');

function jsonLdObjects(html) {
  const objects = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) objects.push(JSON.parse(match[1]));
  return objects;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function firstH1(html) {
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  return match ? decodeEntities(match[1]) : null;
}

function xmlBalanced(xml) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let match;
  while ((match = re.exec(xml))) {
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

test('1. article page SEO, canonical, robots and NewsArticle JSON-LD', () => {
  const record = byTemplate('reveal');
  const html = renderArticlePage(record, fixtures, ctx);

  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
  assert.equal(firstH1(html), record.headline);

  const title = /<title>([\s\S]*?)<\/title>/.exec(html)[1];
  assert.equal(title, `${esc(record.headline)} — Pokoin News`);

  const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)[1];
  assert.equal(canonical, `${baseUrl}/news/${record.slug}`);

  assert.ok(html.includes('max-image-preview:large'));
  assert.ok(html.includes('<meta property="og:type" content="article">'));
  assert.ok(html.includes('property="article:published_time"'));

  const objects = jsonLdObjects(html);
  const article = objects.find((object) => [].concat(object['@type']).includes('NewsArticle'));
  assert.ok(article, 'NewsArticle JSON-LD must be present');
  assert.equal(article.headline, record.headline);
  assert.equal(article.description, record.dek);
  assert.equal(article.datePublished, record.datePublished);
  assert.equal(article.dateModified, record.dateModified);
  assert.equal(article.author[0].name, 'Poko — Pokoin News Desk');
  assert.equal(article.author[0].url, `${baseUrl}/news/authors/poko`);
  assert.equal(article.publisher.name, 'Pokoin');
  assert.equal(article.publisher.logo.url, SITE.logoUrl);
  assert.equal(article.mainEntityOfPage['@id'], `${baseUrl}/news/${record.slug}`);
  assert.ok(Array.isArray(article.image) && article.image.length >= 1);
  for (const url of article.image) assert.match(url, /^https:\/\/pokoin\.com\//);
});

test('2. analysis type is AnalysisNewsArticle and disputed fact checks omit ClaimReview', () => {
  const analysis = byTemplate('analysis');
  const objects = jsonLdObjects(renderArticlePage(analysis, fixtures, ctx));
  const article = objects.find((object) => [].concat(object['@type']).includes('NewsArticle'));
  assert.ok([].concat(article['@type']).includes('AnalysisNewsArticle'));

  const disputed = byTemplate('fact_check');
  const disputedObjects = jsonLdObjects(renderArticlePage(disputed, fixtures, ctx));
  assert.ok(!disputedObjects.some((object) => object['@type'] === 'ClaimReview'));

  const confirmed = clone(disputed);
  confirmed.slug = 'valentines-box-confirmed-fixture';
  confirmed.sources[0].tier = 'A';
  const block = confirmed.blocks.find((entry) => entry.type === 'fact_check');
  block.verdict = 'CONFIRMED';
  block.supportedBy = ['s1'];
  block.contradictedBy = [];
  const confirmedObjects = jsonLdObjects(renderArticlePage(confirmed, fixtures, ctx));
  const claimReview = confirmedObjects.find((object) => object['@type'] === 'ClaimReview');
  assert.ok(claimReview, 'CONFIRMED fact check must emit ClaimReview');
  assert.equal(claimReview.reviewRating.ratingValue, 5);
  assert.equal(claimReview.reviewRating.alternateName, 'CONFIRMED');
});

test('3. home links every published story and never a review record', () => {
  const html = renderHome(fixtures, ctx);
  for (const record of publishedFixtures) {
    assert.ok(html.includes(`<a href="${articlePath(record)}">`), `${record.slug} must be linked`);
  }
  const review = fixtures.find((record) => record.status === 'review');
  assert.ok(review, 'fixture set must contain a review record');
  assert.ok(!html.includes(review.slug), 'review records must not be published or linked');

  for (const page of STATIC_PAGES) {
    const staticHtml = renderStaticPage(page, ctx);
    assert.ok(staticHtml.includes(`<h1>${esc(page.title)}</h1>`));
    assert.ok(staticHtml.includes(`/news/${page.slug}`));
  }
});

test('4. news sitemap window is inclusive at 48h and URL sitemap keeps older stories', () => {
  const record = byTemplate('reveal');
  const publishedAt = new Date(record.datePublished).getTime();
  const within = new Date(publishedAt + 47 * 60 * 60 * 1000);
  const outside = new Date(publishedAt + 49 * 60 * 60 * 1000);

  const fresh = newsSitemap(fixtures, { now: within, baseUrl });
  assert.ok(fresh.includes(`<loc>${baseUrl}/news/${record.slug}</loc>`));
  assert.ok(fresh.includes('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"'));
  assert.ok(fresh.includes('<news:publication_date>'));
  assert.ok(fresh.includes('<news:title>'));

  const stale = newsSitemap(fixtures, { now: outside, baseUrl });
  assert.ok(!stale.includes(`<loc>${baseUrl}/news/${record.slug}</loc>`));
  assert.ok(stale.includes('<urlset'));

  const urlSitemap = newsUrlSitemap(fixtures, { baseUrl });
  assert.ok(urlSitemap.includes(`<loc>${baseUrl}/news/${record.slug}</loc>`));
  assert.ok(urlSitemap.includes(`<loc>${baseUrl}/news</loc>`));
  assert.ok(urlSitemap.includes(`<loc>${baseUrl}/news/authors/poko</loc>`));
});

test('5. RSS is well-formed XML and carries every published link', () => {
  const xml = rssFeed(fixtures, { baseUrl, now: new Date('2026-10-05T00:00:00.000Z') });
  assert.ok(xmlBalanced(xml), 'RSS must be tag-balanced XML');
  assert.ok(xml.includes('xmlns:atom='));
  assert.ok(xml.includes('xmlns:dc='));
  assert.ok(xml.includes('<atom:link'));
  for (const record of publishedFixtures) {
    assert.ok(xml.includes(`${baseUrl}${articlePath(record)}`), `${record.slug} must be in the feed`);
  }
  assert.ok(xml.includes('<pubDate>Sun, 04 Oct 2026 09:14:00 GMT</pubDate>'));
  const review = fixtures.find((record) => record.status === 'review');
  assert.ok(!xml.includes(review.slug));
});

test('6. relatedStories excludes self, unrelated and unpublished records', () => {
  const base = clone(byTemplate('reveal'));
  base.slug = 'related-base-story';
  const sibling = clone(base);
  sibling.slug = 'related-sibling-story';
  sibling.datePublished = '2026-10-05T00:00:00.000Z';

  assert.deepEqual(relatedStories(base, [base, sibling]).map((record) => record.slug), [sibling.slug]);
  assert.deepEqual(relatedStories(base, [base]), []);
  assert.deepEqual(relatedStories(base, [base, byTemplate('fact_check')]), []);

  const unpublished = clone(sibling);
  unpublished.status = 'review';
  assert.deepEqual(relatedStories(base, [base, unpublished]), []);
});

test('7. preview mode forces noindex, nofollow and shows the banner', () => {
  const html = renderHome(fixtures, { ...ctx, preview: true });
  assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
  assert.ok(html.includes('nx-preview-banner'));
  assert.ok(html.includes('PREVIEW — not public'));

  const notFound = renderNotFound(ctx);
  assert.ok(notFound.includes('name="robots" content="noindex, nofollow"'));
});
