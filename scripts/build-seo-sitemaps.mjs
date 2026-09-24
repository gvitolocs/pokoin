#!/usr/bin/env node
/** Canonical hub sitemaps. Card URLs stay on the desk; Google discovers them via hubs + internal links. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SPECIES from '../market/src/data/pokedex-species.js';
import { TCG_ERA_ORDER } from '../market/src/tcg-eras.js';
import { LANGUAGE_HUBS, RARITY_HUBS, SEO_GUIDES } from '../market/src/seo.js';
import { speciesSlug, speciesLabel } from '../market/src/pokemon-hubs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pokoin.com';
/** GSC fetch uses datacenter IPs that Bot Fight 403s on orange-clouded hosts. */
const SITEMAP_ORIGIN = 'https://sitemap.pokoin.com';

function eraId(era) {
  return String(era || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'other';
}

function urlset(urls) {
  const body = urls.map((loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function index(files) {
  const body = files.map((name) => `  <sitemap>\n    <loc>${SITEMAP_ORIGIN}/${name}</loc>\n  </sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

function urlsFromExistingSetsSitemap() {
  try {
    const xml = readFileSync(join(ROOT, 'sitemap-sets.xml'), 'utf8');
    return [...xml.matchAll(/<loc>(https:\/\/pokoin\.com\/marketplace\/sets\/[^<]+)<\/loc>/g)].map((row) => row[1]);
  } catch {
    return [];
  }
}

const byNumber = new Map();
for (const [key, number] of Object.entries(SPECIES)) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || byNumber.has(n)) {
    continue;
  }
  byNumber.set(n, speciesSlug(key));
}

const pokemon = [...byNumber.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([, slug]) => `${ORIGIN}/marketplace/en/pokemon/${slug}`);

const hubs = [
  `${ORIGIN}/`,
  `${ORIGIN}/marketplace`,
  `${ORIGIN}/marketplace/sets`,
  `${ORIGIN}/marketplace/eras`,
  `${ORIGIN}/marketplace/en/pokemon`,
  `${ORIGIN}/marketplace/en/artists`,
  `${ORIGIN}/marketplace/en/rarities`,
  `${ORIGIN}/marketplace/en/languages`,
  `${ORIGIN}/marketplace/en/guides`,
  `${ORIGIN}/sitemap`,
  ...TCG_ERA_ORDER.map((era) => `${ORIGIN}/marketplace/eras/${eraId(era)}`),
  ...RARITY_HUBS.map((row) => `${ORIGIN}/marketplace/en/rarities/${row.slug}`),
  ...LANGUAGE_HUBS.map((row) => `${ORIGIN}/marketplace/en/languages/${row.slug}`),
  ...SEO_GUIDES.map((row) => `${ORIGIN}/marketplace/en/guides/${row.slug}`),
];

const setUrls = [];
try {
  const response = await fetch('https://api.pokoin.com/api/marketplace-expansion-page?limit=2000', {
    headers: { Accept: 'application/json', 'User-Agent': 'pokoin-seo-sitemap/1' },
  });
  if (response.ok) {
    const data = await response.json();
    for (const row of data.expansions || data.sets || []) {
      const slug = String(row.slug || '').trim();
      if (slug) {
        setUrls.push(`${ORIGIN}/marketplace/sets/${slug}`);
      }
    }
  }
} catch (_) {
  /* Vercel build can still ship hubs without the live set list. */
}

if (!setUrls.length) {
  setUrls.push(...urlsFromExistingSetsSitemap());
}

writeFileSync(join(ROOT, 'sitemap-pokemon.xml'), urlset(pokemon));
writeFileSync(join(ROOT, 'sitemap-hubs.xml'), urlset(hubs));
writeFileSync(join(ROOT, 'sitemap-sets.xml'), urlset(setUrls.length ? setUrls : [`${ORIGIN}/marketplace/sets`]));
writeFileSync(join(ROOT, 'sitemap.xml'), index([
  'sitemap-hubs.xml',
  'sitemap-pokemon.xml',
  'sitemap-sets.xml',
]));
console.log('sitemaps', pokemon.length, 'pokemon', setUrls.length, 'sets', speciesLabel('charizard'));
