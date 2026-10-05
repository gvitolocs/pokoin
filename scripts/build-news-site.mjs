#!/usr/bin/env node
// Static build for Pokoin News.
//
// Renders validated article records into dist-news/ as plain assets for the
// assets-only `pokoin-news` Worker (route pokoin.com/news*). The CLI is a thin
// wrapper around buildNewsSite(), which tests call directly.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateArticle } from '../news/lib/schema.mjs';
import { SECTION_NAV } from '../news/lib/format.mjs';
import { esc } from '../news/lib/html.mjs';
import { renderPage } from '../news/lib/layout.mjs';
import {
  renderArticlePage,
  renderAuthorPage,
  renderHome,
  renderNotFound,
  renderSection,
  renderStaticPage,
} from '../news/lib/pages.mjs';
import { newsSitemap, newsUrlSitemap, rssFeed } from '../news/lib/feeds.mjs';
import { SITE, STATIC_PAGES, fallbackHero } from '../news/lib/site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_PREFIX = '/news/media/';
const CSP =
  "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; " +
  "font-src 'self'; connect-src 'self'; base-uri 'self'; object-src 'none'; " +
  "frame-ancestors 'self'; form-action 'self'";

function hash8(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 8);
}

function countLocs(xml) {
  return (xml.match(/<loc>/g) || []).length;
}

function mediaExists(mediaDir, url) {
  if (!mediaDir) return false;
  const relative = url.slice(MEDIA_PREFIX.length);
  return existsSync(join(mediaDir, relative));
}

function heroFileMissing(hero, mediaDir) {
  if (!hero) return false;
  const urls = [hero.url, ...((hero.variants || []).map((variant) => variant && variant.url))];
  return urls.some((url) => typeof url === 'string' && url.startsWith(MEDIA_PREFIX) && !mediaExists(mediaDir, url));
}

function headersFile(preview) {
  const robots = preview ? '  X-Robots-Tag: noindex, nofollow\n' : '';
  return (
    `/news*\n${robots}` +
    `  X-Content-Type-Options: nosniff\n` +
    `  Referrer-Policy: strict-origin-when-cross-origin\n` +
    `  Strict-Transport-Security: max-age=31536000\n` +
    `  Content-Security-Policy: ${CSP}\n` +
    `  Cache-Control: public, max-age=300, stale-while-revalidate=86400\n` +
    `/news/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n` +
    `/news/media/*\n  Cache-Control: public, max-age=86400\n` +
    `/news-sitemap.xml\n${robots}  Cache-Control: public, max-age=300\n`
  );
}

function number(value) {
  return Number.isFinite(value) ? String(value) : '';
}

function renderDesk(records, ctx) {
  const rows = records
    .map((record) => {
      const gate = record.gate || {};
      const failing = (gate.checks || [])
        .filter((check) => check && check.pass === false)
        .map((check) => check.id || check.detail || 'check')
        .join(', ');
      const scores = record.scores || {};
      return (
        `<tr>` +
        `<td><a href="/news/${esc(record.slug)}">${esc(record.headline)}</a></td>` +
        `<td>${esc(record.status)}</td>` +
        `<td>${esc(record.template)}</td>` +
        `<td>${esc(gate.verdict || '')}</td>` +
        `<td>${esc(failing)}</td>` +
        `<td>${esc(number(scores.editorialWorthiness))}</td>` +
        `<td>${esc(number(scores.originalReporting))}</td>` +
        `<td>${esc(record.datePublished || '')}</td>` +
        `<td>${esc(record.dateModified || '')}</td>` +
        `</tr>`
      );
    })
    .join('');
  const body =
    `<section class="nx-section"><h1>Newsroom desk</h1>` +
    `<p class="nx-empty">${records.length} records · preview build</p>` +
    `<table class="nx-table"><thead><tr><th>Headline</th><th>Status</th><th>Template</th>` +
    `<th>Gate</th><th>Failing checks</th><th>Editorial</th><th>Original</th>` +
    `<th>Published</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  return renderPage({
    title: 'Newsroom desk — Pokoin News',
    description: 'Internal preview desk for every article record.',
    canonicalPath: '/news/desk',
    robots: 'noindex, nofollow',
    body,
    activeNav: 'desk',
    preview: true,
    assets: ctx.assets,
  });
}

export function buildNewsSite({
  records,
  outDir = 'dist-news',
  now = new Date(),
  preview = false,
  mediaDir = null,
  baseUrl = SITE.baseUrl,
} = {}) {
  const nowIso = new Date(now).toISOString();
  const list = Array.isArray(records) ? records : (records && records.articles) || [];

  const valid = [];
  const invalid = [];
  for (const record of list) {
    const result = validateArticle(record);
    if (result.ok) valid.push(record);
    else {
      invalid.push({
        slug: (record && record.slug) || '(no slug)',
        status: (record && record.status) || null,
        errors: result.errors,
      });
    }
  }
  const invalidPublished = invalid.filter((entry) => entry.status === 'published').length;

  const renderable = valid.filter((record) =>
    preview ? record.status !== 'withdrawn' : record.status === 'published',
  );

  const fallbacks = [];
  const prepared = renderable.map((record) => {
    if (heroFileMissing(record.hero, mediaDir)) {
      const art = fallbackHero(record.section);
      if (art) {
        fallbacks.push(record.slug);
        return { ...record, hero: art };
      }
    }
    return record;
  });

  const cssSource = readFileSync(join(ROOT, 'news/assets/news.css'));
  const jsSource = readFileSync(join(ROOT, 'news/assets/news.js'));
  const cssName = `news.${hash8(cssSource)}.css`;
  const jsName = `news.${hash8(jsSource)}.js`;
  const assets = { css: `/news/assets/${cssName}`, js: `/news/assets/${jsName}` };
  const ctx = { baseUrl, assets, preview };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'news/assets'), { recursive: true });
  writeFileSync(join(outDir, 'news/assets', cssName), cssSource);
  writeFileSync(join(outDir, 'news/assets', jsName), jsSource);

  const artDir = join(ROOT, 'news/assets/art');
  if (existsSync(artDir)) cpSync(artDir, join(outDir, 'news/assets/art'), { recursive: true });
  if (mediaDir && existsSync(mediaDir)) cpSync(mediaDir, join(outDir, 'news/media'), { recursive: true });

  const writePage = (relativePath, html) => {
    const file = join(outDir, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  };

  writePage('news.html', renderHome(prepared, ctx));
  for (const record of prepared) {
    writePage(
      `news/${record.slug}.html`,
      renderArticlePage(record, prepared, { ...ctx, fallbackHero: fallbackHero(record.section) }),
    );
  }
  for (const item of SECTION_NAV) {
    if (item.id === 'latest') continue;
    writePage(`news/${item.id}.html`, renderSection(item.id, prepared, ctx));
  }
  writePage('news/authors/poko.html', renderAuthorPage(prepared, ctx));
  for (const page of STATIC_PAGES) {
    writePage(`news/${page.slug}.html`, renderStaticPage(page, ctx));
  }
  writePage('news/404.html', renderNotFound(ctx));
  if (preview) writePage('news/desk.html', renderDesk(valid, ctx));

  const urlSitemap = newsUrlSitemap(valid, { baseUrl, now: nowIso });
  const recentSitemap = newsSitemap(valid, { now: nowIso, baseUrl });
  writeFileSync(join(outDir, 'news-sitemap.xml'), recentSitemap);
  writeFileSync(join(outDir, 'news/sitemap.xml'), urlSitemap);
  writeFileSync(join(outDir, 'news/rss.xml'), rssFeed(valid, { baseUrl, now: nowIso }));
  writeFileSync(join(outDir, '_headers'), headersFile(preview));

  const report = {
    outDir,
    now: nowIso,
    preview,
    articles: prepared.length,
    published: prepared.filter((record) => record.status === 'published').length,
    previewOnly: prepared.filter((record) => record.status !== 'published').length,
    sitemapEntries: countLocs(recentSitemap),
    urlSitemapEntries: countLocs(urlSitemap),
    invalid,
    invalidPublished,
    fallbacks,
    css: cssName,
    js: jsName,
  };
  writeFileSync(join(outDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') args.strict = true;
    else if (arg === '--preview') args.preview = true;
    else if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function loadInput(input) {
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`input fetch failed: ${response.status} ${response.statusText}`);
    return response.json();
  }
  return JSON.parse(readFileSync(input, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'usage: node scripts/build-news-site.mjs --input <file.json|https://…> [--out dist-news] ' +
        '[--now ISO] [--preview] [--media-dir DIR] [--base https://pokoin.com] [--strict]',
    );
    process.exit(2);
  }
  const data = await loadInput(args.input);
  const records = Array.isArray(data) ? data : data.articles || [];
  const report = buildNewsSite({
    records,
    outDir: args.out || 'dist-news',
    now: args.now || new Date().toISOString(),
    preview: Boolean(args.preview),
    mediaDir: args['media-dir'] || null,
    baseUrl: args.base || SITE.baseUrl,
  });
  for (const entry of report.invalid) {
    console.error(`invalid ${entry.slug}: ${entry.errors.slice(0, 3).join('; ')}`);
  }
  for (const slug of report.fallbacks) {
    console.log(`fallback-hero ${slug}`);
  }
  console.log(
    `news build: ${report.articles} articles (${report.published} published, ${report.previewOnly} preview-only), ` +
      `${report.sitemapEntries} sitemap(2d) entries → ${report.outDir}`,
  );
  if (args.strict && report.invalidPublished > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
