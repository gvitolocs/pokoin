// Multi-TCG publication: Pokémon at /news, every other game at /<slug>/news.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNewsSite } from '../../scripts/build-news-site.mjs';
import { articlePath, gameNewsBase } from '../lib/schema.mjs';
import { relatedStories } from '../lib/related.mjs';
import { newsSitemap, newsUrlSitemap } from '../lib/feeds.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, '../fixtures/sample-articles.json'), 'utf8'));
const lorcana = fixtures.find((record) => record.game === 'lorcana');
const pokemon = fixtures.filter((record) => record.game === 'pokemon' && record.status === 'published');
const baseUrl = 'https://pokoin.com';
const now = new Date('2026-10-05T00:00:00.000Z');

function build() {
  const outDir = mkdtempSync(join(tmpdir(), 'news-games-'));
  const report = buildNewsSite({ records: fixtures, outDir, now, baseUrl });
  return { outDir, report, read: (path) => readFileSync(join(outDir, path), 'utf8') };
}

test('game URLs mirror the marketplace layout', () => {
  assert.equal(gameNewsBase('pokemon'), '/news');
  assert.equal(gameNewsBase('one_piece'), '/one-piece/news');
  assert.equal(articlePath(lorcana), `/lorcana/news/${lorcana.slug}`);
});

test('a Lorcana story lives under /lorcana/news with its own canonical, breadcrumb and nav', () => {
  const { read, report } = build();
  assert.ok(report.games.includes('lorcana'));
  const html = read(`lorcana/news/${lorcana.slug}.html`);
  assert.ok(html.includes(`<link rel="canonical" href="${baseUrl}/lorcana/news/${lorcana.slug}">`));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld.mainEntityOfPage['@id'], `${baseUrl}/lorcana/news/${lorcana.slug}`);
  assert.match(html, /<li><a href="\/lorcana\/news">Lorcana<\/a><\/li>/, 'breadcrumb names the game');
  assert.match(html, /href="\/lorcana\/news\/collectors"/, 'section nav is scoped to the game');
  assert.match(html, /<nav class="nx-games" aria-label="Games">/);
  assert.match(html, /<a href="\/lorcana\/news" aria-current="true">Lorcana<\/a>/);
  assert.match(html, /href="\/lorcana\/marketplace">Marketplace</);
  assert.ok(!existsSync(join(build().outDir, 'news', `${lorcana.slug}.html`)), 'never duplicated under /news');
});

test('/news is the Pokémon front page; other games appear only in the cross-game rail', () => {
  const { read } = build();
  const home = read('news.html');
  const front = home.slice(home.indexOf('<div class="nx-front">'), home.indexOf('<section class="nx-rail">'));
  assert.ok(!front.includes(lorcana.slug), 'the Pokémon front never leads with another game');
  assert.match(home, /<h2>Across the TCGs<\/h2>/);
  assert.ok(home.includes(`<a href="/lorcana/news/${lorcana.slug}">`));
  for (const record of pokemon) assert.ok(home.includes(`<a href="${articlePath(record)}">`));
});

test('each game has its own hub, sections and RSS; /news/all.xml carries every game', () => {
  const { outDir, read } = build();
  const hub = read('lorcana/news.html');
  assert.ok(hub.includes(lorcana.headline));
  for (const record of pokemon) assert.ok(!hub.includes(record.headline), 'the Lorcana hub lists only Lorcana');
  assert.ok(existsSync(join(outDir, 'lorcana/news/collectors.html')));
  assert.ok(!existsSync(join(outDir, 'lorcana/news/market.html')), 'empty sections are not generated for other games');
  assert.ok(read('lorcana/news/rss.xml').includes(`/lorcana/news/${lorcana.slug}`));
  assert.ok(!read('news/rss.xml').includes(lorcana.slug), '/news/rss.xml is the Pokémon feed');
  assert.ok(read('news/all.xml').includes(lorcana.slug));
  assert.match(read('_headers'), /^\/lorcana\/news\*$/m);
});

test('sitemaps use game paths', () => {
  const recent = newsSitemap(fixtures, { now: new Date('2026-10-05T09:00:00.000Z'), baseUrl });
  assert.ok(recent.includes(`<loc>${baseUrl}/lorcana/news/${lorcana.slug}</loc>`));
  const urls = newsUrlSitemap(fixtures, { baseUrl, now });
  assert.ok(urls.includes(`<loc>${baseUrl}/lorcana/news</loc>`));
  assert.ok(urls.includes(`<loc>${baseUrl}/lorcana/news/collectors</loc>`));
  assert.ok(!urls.includes(`<loc>${baseUrl}/lorcana/news/market</loc>`));
  assert.ok(urls.includes(`<loc>${baseUrl}/news/market</loc>`));
});

test('related stories never cross games', () => {
  const twin = { ...pokemon[0], game: 'lorcana', slug: 'lorcana-twin-of-a-pokemon-story', id: 'twin' };
  const related = relatedStories(pokemon[0], [...fixtures, twin]);
  assert.ok(related.every((record) => (record.game || 'pokemon') === 'pokemon'));
});

test('a game\'s section nav only links pages that exist', () => {
  const { outDir, read } = build();
  const hub = read('lorcana/news.html');
  const links = [...hub.matchAll(/href="(\/lorcana\/news\/[a-z-]+)"/g)].map((match) => match[1])
    .filter((href) => !href.endsWith(lorcana.slug));
  assert.ok(links.length > 0);
  for (const href of links) assert.ok(existsSync(join(outDir, `${href.slice(1)}.html`)), `${href} must exist`);
  assert.ok(!hub.includes('href="/lorcana/news/market"'));
});

test('every game in the switcher has a hub page, even before its first story', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'news-pinned-'));
  buildNewsSite({ records: fixtures.filter((record) => record.game === 'pokemon'), outDir, now, baseUrl });
  for (const root of ['news', 'one-piece/news', 'magic/news', 'yugioh/news', 'lorcana/news', 'riftbound/news']) {
    assert.ok(existsSync(join(outDir, `${root}.html`)), `${root} hub`);
  }
  const magic = readFileSync(join(outDir, 'magic/news.html'), 'utf8');
  assert.match(magic, /No Magic: The Gathering stories yet/);
  assert.match(magic, /<meta name="robots" content="noindex, follow">/);
  assert.doesNotMatch(readFileSync(join(outDir, 'news.html'), 'utf8'), /noindex/);
});
