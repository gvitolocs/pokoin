#!/usr/bin/env node
/** Write sitemap-cards-NNN.xml for canonical catalog desks. Does not query Google. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardSitemapFileName, chunkCardPaths, renderUrlSet } from './card-sitemap.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pokoin.com';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const file = arg('--file');
if (!file) {
  console.error('Usage: node scripts/build-card-sitemaps.mjs --file urls.txt [--dry-run]');
  console.error('urls.txt is one canonical card path or pokoin.com URL per line.');
  console.error('A full catalog extract is: select canonical_path from public.marketplace_card_urls where language = \'en\'');
  process.exit(1);
}

const paths = readFileSync(file, 'utf8').split(/\r?\n/);
const chunks = chunkCardPaths(paths);
const dryRun = process.argv.includes('--dry-run');
const names = chunks.map((_, index) => cardSitemapFileName(index));
if (!dryRun) {
  chunks.forEach((chunk, index) => {
    writeFileSync(join(ROOT, names[index]), renderUrlSet(chunk, ORIGIN));
  });
}
console.log(JSON.stringify({
  dryRun,
  files: names,
  urls: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  droppedQueryUrls: paths.filter((line) => /[?]/.test(line)).length,
}));
