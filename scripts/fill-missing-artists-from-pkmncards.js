#!/usr/bin/env node
/** Fill empty leftover artists from pkmncards.com illustrator pages.
 *
 * CLIP same_artwork copies that disagree with a name+set+number hit are
 * corrected (Southern Islands Ledyba was Skyridge Yamashita). Never overwrite
 * ocr_illus / pokemontcg.io / tcgdex / pokemon_tcg_data.
 *
 *   node scripts/fill-missing-artists-from-pkmncards.js --artist=keiko-fukuyama
 *   node scripts/fill-missing-artists-from-pkmncards.js --artist=keiko-fukuyama --apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artistPageUrl,
  parseArtistPage,
  printingKey,
  shouldWriteArtist,
} from './pkmncards-artists.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = process.env.POKOIN_MARKETPLACE_POSTGRES || 'pokoin-marketplace-postgres-15t';
const APPLY = process.argv.includes('--apply');
const artistArg = process.argv.find((arg) => arg.startsWith('--artist='));
const htmlArg = process.argv.find((arg) => arg.startsWith('--html='));
const slug = artistArg ? artistArg.slice('--artist='.length) : 'keiko-fukuyama';
const pageUrl = artistPageUrl(slug);
const artistName = slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');

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

function fetchArtistHtml() {
  if (htmlArg) {
    return readFileSync(resolve(ROOT, htmlArg.slice('--html='.length)), 'utf8');
  }
  const curl = spawnSync(
    'curl',
    ['-sS', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36', '-H', 'Accept: text/html', pageUrl],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (curl.status === 0 && curl.stdout.includes('/card/') && !curl.stdout.includes('412 Precondition Failed')) {
    return curl.stdout;
  }
  const play = spawnSync(
    'playwright-cli',
    ['eval', '-s', pageUrl, 'document.documentElement.outerHTML'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (play.status === 0 && play.stdout.includes('/card/')) {
    return play.stdout;
  }
  throw new Error(`Could not fetch ${pageUrl} (curl 412 / playwright ${play.status || curl.status})`);
}

const html = fetchArtistHtml();
const cards = parseArtistPage(html, { artist: artistName, pageUrl });
if (!cards.length) {
  throw new Error(`No pkmncards printings on ${pageUrl}`);
}

const catalog = psql(`
SELECT c.ct_id || E'\\t' || c.card_id || E'\\t' || coalesce(c.name,'') || E'\\t' || coalesce(c.set_name,'') || E'\\t' || coalesce(c.card_number,'') || E'\\t' || coalesce(a.artist,'') || E'\\t' || coalesce(a.source,'')
FROM marketplace_search_candidates c
LEFT JOIN marketplace_blueprint_artists a ON a.card_id = c.card_id
WHERE coalesce(c.item_kind, 'single') = 'single'
  AND coalesce(c.product_type, 'card') IN ('card', '');
`).trim().split('\n').filter(Boolean).map((line) => {
  const [ctId, cardId, name, set_name, card_number, artist, source] = line.split('\t');
  return {
    ct_id: Number(ctId),
    card_id: Number(cardId),
    name,
    set_name,
    card_number,
    artist,
    source,
  };
});

const byKey = new Map();
for (const row of catalog) {
  const key = printingKey(row.name, row.set_name, row.card_number);
  if (!key) continue;
  const bucket = byKey.get(key) || [];
  bucket.push(row);
  byKey.set(key, bucket);
}

const fills = [];
const unmatched = [];
for (const card of cards) {
  const key = printingKey(card.name, card.set, card.number);
  const rows = byKey.get(key) || [];
  if (!rows.length) {
    unmatched.push(card);
    continue;
  }
  for (const row of rows) {
    if (!shouldWriteArtist(row.source, row.artist, artistName)) continue;
    fills.push({
      ctId: row.ct_id,
      cardId: row.card_id,
      artist: artistName,
      prev: row.artist,
      prevSource: row.source,
      name: row.name,
      set: row.set_name,
      url: card.url,
    });
  }
}

const report = {
  pageUrl,
  artist: artistName,
  pkmncards: cards.length,
  fills: fills.length,
  unmatched: unmatched.map((row) => `${row.name} ${row.set} #${row.number}`),
  sample: fills.slice(0, 12),
  apply: APPLY,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync('/tmp/fill-pkmncards-artists.json', `${JSON.stringify({ ...report, fills }, null, 2)}\n`);

if (!APPLY || !fills.length) process.exit(0);

psql('ALTER TABLE marketplace_blueprint_artists DISABLE TRIGGER marketplace_blueprint_artists_copy_same_art;');
for (const row of fills) {
  const norm = String(row.artist).toLowerCase().replace(/\s+/g, ' ').trim();
  const meta = sqlLiteral(JSON.stringify({
    pkmncards: row.url,
    prev_artist: row.prev || '',
    prev_source: row.prevSource || '',
  }));
  psql(`
INSERT INTO marketplace_blueprint_artists (
  blueprint_id, ct_id, artist, illustrator, normalized_artist, source, source_card_id, source_url, confidence, match_reason, raw_metadata
) VALUES (
  ${row.ctId}, ${row.ctId}, ${sqlLiteral(row.artist)}, ${sqlLiteral(row.artist)}, ${sqlLiteral(norm)},
  'pkmncards', ${sqlLiteral(String(row.ctId))}, ${sqlLiteral(row.url)}, 0.95, 'pkmncards_artist_page', ${meta}::jsonb
)
ON CONFLICT (blueprint_id) DO UPDATE
  SET artist = EXCLUDED.artist,
      illustrator = EXCLUDED.illustrator,
      normalized_artist = EXCLUDED.normalized_artist,
      source = EXCLUDED.source,
      source_url = EXCLUDED.source_url,
      confidence = EXCLUDED.confidence,
      match_reason = EXCLUDED.match_reason,
      raw_metadata = EXCLUDED.raw_metadata,
      updated_at = now()
  WHERE marketplace_blueprint_artists.source = 'same_artwork'
     OR coalesce(marketplace_blueprint_artists.artist, '') = '';
`);
}
psql('ALTER TABLE marketplace_blueprint_artists ENABLE TRIGGER marketplace_blueprint_artists_copy_same_art;');
const copied = psql('SELECT public.marketplace_copy_same_art_artists();').trim();
let counts = '';
try {
  counts = psql('SELECT public.refresh_marketplace_artist_card_counts();').trim();
} catch (error) {
  counts = String(error.message || error).slice(0, 200);
}
console.log(JSON.stringify({ copied, counts }, null, 2));
