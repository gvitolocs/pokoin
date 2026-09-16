#!/usr/bin/env node
/** Fill empty marketplace_blueprint_artists from OCR Illus. + pokemontcg.io.
 *
 * OCR jsonl is leftover `ct_id` (JPEG basename). Missing-row lookup joins
 * artists.card_id = cards.card_id (public leftover × 2). INSERT still uses
 * leftover blueprint_id. Trigger 073 copies onto candidates.artist.
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  cardArtistKey,
  foldArtistKey,
  matchOcrArtist,
  parseOcrArtists,
  splitArtistCredits,
} from '../market/src/ocr-artists.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSONLS = [
  resolve(ROOT, 'scripts/out/western-full-ocr.jsonl'),
  resolve(ROOT, 'scripts/out/western-full-ocr-gpu.jsonl'),
];
const IO_DIR = process.env.POKEMONTCG_DATA_DIR || '/home/nez/data/pokemon-tcg-data';
const CONTAINER = process.env.POKOIN_MARKETPLACE_POSTGRES || 'pokoin-marketplace-postgres-15t';
const APPLY = process.argv.includes('--apply');
const WESTERN = new Set(['western', 'american', 'french']);

async function loadJsonl(path) {
  const byId = new Map();
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const ctId = Number(row.ct_id);
    if (!Number.isFinite(ctId)) continue;
    const prev = byId.get(ctId);
    const text = String(row.text || '');
    if (!prev || (row.ok && !prev.ok) || text.length > String(prev.text || '').length) {
      byId.set(ctId, row);
    }
  }
  return byId;
}

async function loadIo(dir) {
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

function uniqueIoArtist(name, num, io) {
  const key = cardArtistKey(name, num);
  if (!key) return '';
  const bucket = io.byCard.get(key);
  if (!bucket || bucket.size !== 1) return '';
  return [...bucket][0];
}

function ioArtistsFor(name, num, io) {
  const key = cardArtistKey(name, num);
  if (!key) return [];
  const bucket = io.byCard.get(key);
  return bucket ? [...bucket] : [];
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psql(sql) {
  const result = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'pokoin_marketplace', '-d', 'pokoin_marketplace', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: sql, encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql ${result.status}`);
  }
  return result.stdout;
}

function matchFromOcr(ocr, catalogName, catalogNum, io) {
  const name = ocr.name || catalogName;
  const num = ocr.num || catalogNum;
  const extracted = parseOcrArtists(ocr.text);
  const cardArtists = ioArtistsFor(name, num, io);
  const ioFolds = new Set(io.names.map(foldArtistKey));
  const hits = [];
  for (const raw of extracted) {
    const canonical = matchOcrArtist(raw, io.names, cardArtists);
    if (!canonical) continue;
    const folded = foldArtistKey(canonical);
    if (io.pokemon.has(folded) && !ioFolds.has(folded)) continue;
    hits.push(canonical);
  }
  return { extracted, hits };
}

const ocrById = new Map();
for (const path of JSONLS) {
  const chunk = await loadJsonl(path);
  for (const [id, row] of chunk) ocrById.set(id, row);
}
const io = await loadIo(IO_DIR);

const missingRaw = psql(`
SELECT c.ct_id || E'\\t' || coalesce(c.name,'') || E'\\t' || coalesce(c.card_number,'') || E'\\t' || coalesce(e.nationality,'')
FROM marketplace_cards c
LEFT JOIN marketplace_blueprint_artists a ON a.card_id = c.card_id
LEFT JOIN pokoin_pokemon_blueprints b ON b.id = c.ct_id
LEFT JOIN pokoin_pokemon_expansions e ON e.expansion_id = b.expansion_id
WHERE coalesce(nullif(a.illustrator,''), nullif(a.artist,'')) IS NULL
  AND coalesce(c.item_kind, 'single') = 'single'
  AND coalesce(c.product_type, 'card') IN ('card', '');
`);

const fills = [];
const stats = {
  missing: 0,
  ocr: 0,
  io: 0,
  none: 0,
  ocrNoIllus: 0,
  ocrIllusUnmatched: 0,
  westernMissing: 0,
};
for (const line of missingRaw.split('\n')) {
  if (!line.trim()) continue;
  stats.missing += 1;
  const [ct, name, num, nationality] = line.split('\t');
  const ctId = Number(ct);
  const west = WESTERN.has(String(nationality || '').toLowerCase());
  if (west) stats.westernMissing += 1;
  const ocr = ocrById.get(ctId);
  let artist = '';
  let source = '';
  let reason = '';
  if (ocr) {
    const { extracted, hits } = matchFromOcr(ocr, name, num, io);
    if (hits[0]) {
      artist = hits[0];
      source = 'ocr_illus';
      reason = 'ocr_illus_io';
    } else if (!extracted.length) {
      stats.ocrNoIllus += 1;
    } else {
      stats.ocrIllusUnmatched += 1;
    }
  }
  if (!artist && west) {
    const ioName = uniqueIoArtist(name, ocr?.num || num, io);
    if (ioName) {
      artist = ioName;
      source = 'pokemontcg.io';
      reason = 'unique_name_number';
    }
  }
  if (!artist) {
    stats.none += 1;
    continue;
  }
  if (source === 'ocr_illus') stats.ocr += 1;
  else stats.io += 1;
  fills.push({ ctId, artist, source, reason, name, nationality });
}

const sample = fills.slice(0, 12).map((row) => `${row.ctId} ${row.artist} ${row.source}`);
const meowth = fills.filter((row) => row.ctId === 378907 || row.ctId === 403830 || row.ctId === 367188);
console.log(JSON.stringify({
  ...stats,
  fills: fills.length,
  ocrRows: ocrById.size,
  ioNames: io.names.length,
  apply: APPLY,
  meowth,
  sample,
}, null, 2));
writeFileSync('/tmp/fill-missing-artists.json', `${JSON.stringify({ stats, fills }, null, 2)}\n`);

if (!APPLY || !fills.length) process.exit(0);

const values = fills.map((row) => {
  // Match SPA artistSlug(): strip diacritics so DB-side slugifying yields the same slug.
  const norm = String(row.artist).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `(${row.ctId}, ${row.ctId}, ${sqlLiteral(row.artist)}, ${sqlLiteral(row.artist)}, ${sqlLiteral(norm)}, ${sqlLiteral(row.source)}, ${sqlLiteral(String(row.ctId))}, '', 0.9, ${sqlLiteral(row.reason)}, '{}'::jsonb)`;
});

psql('ALTER TABLE marketplace_blueprint_artists DISABLE TRIGGER marketplace_blueprint_artists_copy_same_art;');
const chunkSize = 400;
for (let offset = 0; offset < values.length; offset += chunkSize) {
  const chunk = values.slice(offset, offset + chunkSize);
  psql(`
INSERT INTO marketplace_blueprint_artists (
  blueprint_id, ct_id, artist, illustrator, normalized_artist, source, source_card_id, source_url, confidence, match_reason, raw_metadata
) VALUES
${chunk.join(',\n')}
ON CONFLICT (blueprint_id) DO NOTHING;
`);
  console.log(`inserted ${Math.min(offset + chunk.length, values.length)}/${values.length}`);
}
psql('ALTER TABLE marketplace_blueprint_artists ENABLE TRIGGER marketplace_blueprint_artists_copy_same_art;');
const copied = psql('SELECT public.marketplace_copy_same_art_artists();').trim();
let counts = '';
try {
  counts = psql('SELECT public.refresh_marketplace_artist_card_counts();').trim();
} catch (error) {
  counts = String(error.message || error).slice(0, 200);
}
const after = psql(`
SELECT count(*) FROM marketplace_blueprint_artists;
SELECT artist, illustrator, source, match_reason
FROM marketplace_blueprint_artists
WHERE blueprint_id IN (378907, 403830, 367188);
`).trim();
console.log(JSON.stringify({ copied, counts, after }, null, 2));
