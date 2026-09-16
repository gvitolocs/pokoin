#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artistIndexFromOcrRows,
  cardArtistKey,
  foldArtistKey,
  splitArtistCredits,
} from '../market/src/ocr-artists.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSONLS = [
  resolve(ROOT, 'scripts/out/western-full-ocr.jsonl'),
  resolve(ROOT, 'scripts/out/western-full-ocr-gpu.jsonl'),
];
const OUT = resolve(ROOT, 'market/public/review/western-artists.json');
const IO_DIR = process.env.POKEMONTCG_DATA_DIR || '/home/nez/data/pokemon-tcg-data';

async function loadJsonl(path) {
  const rows = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function loadPokemonTcgIoArtists(dir) {
  const names = new Map();
  const byCard = new Map();
  const pokemon = new Set();
  const files = await readdir(join(dir, 'cards/en'));
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const cards = JSON.parse(await readFile(join(dir, 'cards/en', file), 'utf8'));
    for (const card of cards) {
      const poke = foldArtistKey(String(card.name || '').replace(/\s+lv\.?\s*\d+/i, ''));
      if (poke) pokemon.add(poke);
      for (const name of splitArtistCredits(card.artist)) {
        const folded = foldArtistKey(name);
        if (folded) names.set(folded, name);
        const key = cardArtistKey(card.name, card.number);
        if (!key) continue;
        let bucket = byCard.get(key);
        if (!bucket) {
          bucket = new Set();
          byCard.set(key, bucket);
        }
        bucket.add(name);
      }
    }
  }
  return { names: [...names.values()], byCard, pokemon };
}

const rows = [];
for (const path of JSONLS) {
  rows.push(...await loadJsonl(path));
}
const io = await loadPokemonTcgIoArtists(IO_DIR);
const index = artistIndexFromOcrRows(rows, { examples: 3, io });
const payload = {
  revision: '2026-09-13-drop-flavor',
  generatedAt: new Date().toISOString(),
  path: '/ocr/artists',
  source: 'Western PP-OCRv5 Illus. line, names corrected against pokemontcg.io artist credits.',
  rule: 'Garbled OCR names map to pokemontcg.io when the credit is close. Flavor-text OCR is dropped. Unmatched Illus. names stay only when they look like a credit.',
  totals: {
    cards: index.cards,
    withArtist: index.withArtist,
    missing: index.missing,
    unique: index.artists.length,
    matchedIo: index.matchedIo,
    ioArtists: io.names.length,
  },
  artists: index.artists,
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(payload)}\n`);
console.log(
  `wrote ${OUT} cards=${index.cards} withArtist=${index.withArtist} unique=${index.artists.length} io=${io.names.length} matched=${index.matchedIo}`,
);
console.log('top', index.artists.slice(0, 8).map((row) => `${row.name} ${row.count}`).join(' · '));
