// Static-build tests for Pokoin News (task W3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNewsSite } from '../../scripts/build-news-site.mjs';
import { esc } from '../lib/html.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'sample-articles.json'), 'utf8'));
const baseUrl = 'https://pokoin.com';
const now = '2026-10-04T12:00:00Z';
const published = fixtures.filter((record) => record.status === 'published');
const clone = (record) => JSON.parse(JSON.stringify(record));
const tmp = () => mkdtempSync(join(tmpdir(), 'news-build-'));

function cssBlock(css, selector) {
  const index = css.indexOf(`${selector} {`);
  if (index < 0) return '';
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

test('1. public build writes pages, feeds, headers and hashed assets', () => {
  const outDir = tmp();
  const report = buildNewsSite({ records: fixtures, outDir, now, baseUrl });

  assert.ok(existsSync(join(outDir, 'news.html')));
  for (const record of published) assert.ok(existsSync(join(outDir, 'news', `${record.slug}.html`)));
  for (const section of ['sets', 'cards', 'market', 'competitive', 'collectors', 'fact-check', 'analysis']) {
    assert.ok(existsSync(join(outDir, 'news', `${section}.html`)), `missing section ${section}`);
  }
  assert.ok(existsSync(join(outDir, 'news/authors/poko.html')));
  for (const page of ['about', 'editorial-policy', 'corrections', 'methodology', 'contact']) {
    assert.ok(existsSync(join(outDir, 'news', `${page}.html`)));
  }
  assert.ok(existsSync(join(outDir, 'news/404.html')));
  assert.ok(existsSync(join(outDir, 'news-sitemap.xml')));
  assert.ok(existsSync(join(outDir, 'news/sitemap.xml')));
  assert.ok(existsSync(join(outDir, 'news/rss.xml')));
  assert.ok(existsSync(join(outDir, '_headers')));
  assert.ok(existsSync(join(outDir, 'build-report.json')));
  assert.match(report.css, /^news\.[0-9a-f]{8}\.css$/);
  assert.match(report.js, /^news\.[0-9a-f]{8}\.js$/);
  assert.ok(existsSync(join(outDir, 'news/assets', report.css)));
  assert.ok(existsSync(join(outDir, 'news/assets', report.js)));
  assert.ok(existsSync(join(outDir, 'news/assets/art/manifest.json')));
});

test('2. review records stay out of the public build and appear in preview', () => {
  const review = fixtures.find((record) => record.status === 'review');
  assert.ok(review, 'fixtures need a review record');

  const publicOut = tmp();
  buildNewsSite({ records: fixtures, outDir: publicOut, now, baseUrl });
  assert.ok(!existsSync(join(publicOut, 'news', `${review.slug}.html`)));
  assert.ok(!readFileSync(join(publicOut, 'news.html'), 'utf8').includes(`/news/${review.slug}`));
  for (const file of ['news-sitemap.xml', 'news/sitemap.xml', 'news/rss.xml']) {
    assert.ok(!readFileSync(join(publicOut, file), 'utf8').includes(review.slug), `${file} leaked review`);
  }
  assert.ok(!existsSync(join(publicOut, 'news/desk.html')));

  const previewOut = tmp();
  buildNewsSite({ records: fixtures, outDir: previewOut, now, baseUrl, preview: true });
  const html = readFileSync(join(previewOut, 'news', `${review.slug}.html`), 'utf8');
  assert.ok(html.includes('noindex, nofollow'));
  assert.ok(html.includes('nx-preview-banner'));
  assert.ok(existsSync(join(previewOut, 'news/desk.html')));
});

test('3. invalid records are skipped and counted, including strict semantics', () => {
  const bad = clone(fixtures.find((record) => record.template === 'reveal'));
  bad.slug = 'invalid-emoji-record';
  bad.headline = 'Pokémon TCG 🎉 Delta Reign Prerelease Promos Revealed';

  const outDir = tmp();
  const report = buildNewsSite({ records: [...fixtures, bad], outDir, now, baseUrl });
  assert.ok(report.invalid.some((entry) => entry.slug === 'invalid-emoji-record'));
  assert.ok(report.invalidPublished > 0, 'published invalid records must be counted for --strict');
  assert.ok(!existsSync(join(outDir, 'news/invalid-emoji-record.html')));
});

test('4. a hero whose media file is missing falls back to branded art', () => {
  const mediaDir = mkdtempSync(join(tmpdir(), 'news-media-'));
  const outDir = tmp();
  const reveal = fixtures.find((record) => record.template === 'reveal');
  const report = buildNewsSite({ records: fixtures, outDir, now, baseUrl, mediaDir });

  const html = readFileSync(join(outDir, 'news', `${reveal.slug}.html`), 'utf8');
  assert.ok(html.includes('/news/assets/art/fallback-'));
  assert.ok(report.fallbacks.includes(reveal.slug));
});

test('5. article HTML carries the full body with scripts stripped', () => {
  const outDir = tmp();
  buildNewsSite({ records: fixtures, outDir, now, baseUrl });
  const record = fixtures.find((entry) => entry.template === 'market_pulse');
  const html = readFileSync(join(outDir, 'news', `${record.slug}.html`), 'utf8');
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');

  for (const block of record.blocks.filter((entry) => entry.type === 'paragraph')) {
    assert.ok(withoutScripts.includes(esc(block.text)), 'paragraph text must render without JS');
  }
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.ok(html.includes(`<link rel="canonical" href="${baseUrl}/news/${record.slug}">`));
  assert.ok(html.includes('application/ld+json'));
  assert.ok(withoutScripts.includes(esc(record.headline)));
});

test('6. the home page links every published article', () => {
  const outDir = tmp();
  buildNewsSite({ records: fixtures, outDir, now, baseUrl });
  const home = readFileSync(join(outDir, 'news.html'), 'utf8');
  for (const record of published) {
    assert.ok(home.includes(`<a href="/news/${record.slug}">`), `${record.slug} must be linked`);
  }
});

test('7. _headers carries the CSP and immutable assets rule', () => {
  const publicOut = tmp();
  buildNewsSite({ records: fixtures, outDir: publicOut, now, baseUrl });
  const headers = readFileSync(join(publicOut, '_headers'), 'utf8');
  assert.ok(headers.includes('Content-Security-Policy:'));
  assert.ok(headers.includes("default-src 'self'"));
  assert.ok(headers.includes('max-age=31536000, immutable'));

  const previewOut = tmp();
  buildNewsSite({ records: fixtures, outDir: previewOut, now, baseUrl, preview: true });
  assert.ok(readFileSync(join(previewOut, '_headers'), 'utf8').includes('X-Robots-Tag: noindex, nofollow'));
});

test('8. shell is mobile-safe: viewport, media query, no wide fixed containers', () => {
  const outDir = tmp();
  const report = buildNewsSite({ records: fixtures, outDir, now, baseUrl });
  const html = readFileSync(join(outDir, 'news.html'), 'utf8');
  assert.ok(html.includes('name="viewport"'));

  const css = readFileSync(join(outDir, 'news/assets', report.css), 'utf8');
  assert.match(css, /@media \(max-width:/);

  for (const selector of ['.nx-front', '.nx-article']) {
    const block = cssBlock(css, selector);
    assert.ok(block, `${selector} block must exist`);
    const widths = [...block.matchAll(/(?<!max-)(?<!min-)\bwidth:\s*(\d+)px/g)].map((match) => Number(match[1]));
    for (const width of widths) assert.ok(width <= 360, `${selector} has fixed width ${width}px`);
  }
});
