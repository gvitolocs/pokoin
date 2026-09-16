#!/usr/bin/env node
/**
 * Persist artist Pokédex / CLIP same-artwork order on 15T candidates.
 * New CardTrader rows pick the rank from name/set caches; CLIP version
 * changes recompute cluster-oldest in SQL.
 */
import { spawnSync } from 'node:child_process';
import { albumSortParts } from '../market/src/search-filters.js';

const CONTAINER = process.env.POKOIN_MARKETPLACE_POSTGRES || 'pokoin-marketplace-postgres-15t';
const APPLY = process.argv.includes('--apply');

function dockerPsql(input) {
  const result = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'pokoin_marketplace', '-d', 'pokoin_marketplace', '-v', 'ON_ERROR_STOP=1'],
    { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql ${result.status}`);
  }
  return result.stdout;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      if (row.some((part) => part !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((part) => part !== '')) rows.push(row);
  }
  return rows;
}

const dump = dockerPsql(`
COPY (
  SELECT card_id, name, expansion_name, card_number
  FROM public.marketplace_search_candidates
  ORDER BY card_id
) TO STDOUT WITH (FORMAT csv);
`);

const cards = parseCsv(dump).map(([cardId, name, expansionName, number]) => ({
  id: cardId,
  name: name || '',
  set: expansionName || '',
  number: number || '',
}));

function sqlInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 999999999;
  return Math.max(0, Math.min(2_000_000_000, Math.round(n)));
}

const nameCache = new Map();
const setCache = new Map();
const stage = [];
for (const card of cards) {
  const parts = albumSortParts(card);
  const pokedexNum = sqlInt(parts.pokedexNum);
  const expansionSort = sqlInt(parts.expansionSort);
  const collectorSort = sqlInt(parts.collectorSort);
  if (!nameCache.has(card.name)) nameCache.set(card.name, pokedexNum);
  if (!setCache.has(card.set)) setCache.set(card.set, expansionSort);
  stage.push([card.id, pokedexNum, expansionSort, collectorSort]);
}

console.log(JSON.stringify({
  cards: cards.length,
  names: nameCache.size,
  sets: setCache.size,
  apply: APPLY,
}, null, 2));

if (!APPLY) process.exit(0);

const nameCsv = [...nameCache.entries()].map(([name, n]) => `${csvCell(name)},${n}`).join('\n');
const setCsv = [...setCache.entries()].map(([name, n]) => `${csvCell(name)},${n}`).join('\n');
const cardCsv = stage.map((row) => row.map((value) => csvCell(value)).join(',')).join('\n');

const applied = dockerPsql(`
SET statement_timeout = 0;
CREATE TEMP TABLE pokedex_name_stage (name text primary key, pokedex_num integer not null);
CREATE TEMP TABLE expansion_name_stage (expansion_name text primary key, expansion_sort integer not null);
CREATE TEMP TABLE pokedex_card_stage (
  card_id bigint primary key,
  pokedex_num integer not null,
  expansion_sort integer not null,
  collector_sort integer not null
);
COPY pokedex_name_stage (name, pokedex_num) FROM STDIN WITH (FORMAT csv);
${nameCsv}
\\.
COPY expansion_name_stage (expansion_name, expansion_sort) FROM STDIN WITH (FORMAT csv);
${setCsv}
\\.
COPY pokedex_card_stage (card_id, pokedex_num, expansion_sort, collector_sort) FROM STDIN WITH (FORMAT csv);
${cardCsv}
\\.
INSERT INTO public.pokoin_pokedex_name_sort (name, pokedex_num)
SELECT name, pokedex_num FROM pokedex_name_stage
ON CONFLICT (name) DO UPDATE SET pokedex_num = excluded.pokedex_num;
INSERT INTO public.pokoin_expansion_name_sort (expansion_name, expansion_sort)
SELECT expansion_name, expansion_sort FROM expansion_name_stage
ON CONFLICT (expansion_name) DO UPDATE SET expansion_sort = excluded.expansion_sort;
ALTER TABLE public.marketplace_search_candidates
  DISABLE TRIGGER marketplace_search_candidates_pokedex_sort_upd;
UPDATE public.marketplace_search_candidates c
SET
  pokedex_num = s.pokedex_num,
  expansion_sort = s.expansion_sort,
  collector_sort = s.collector_sort
FROM pokedex_card_stage s
WHERE c.card_id = s.card_id
  AND (
    c.pokedex_num IS DISTINCT FROM s.pokedex_num
    OR c.expansion_sort IS DISTINCT FROM s.expansion_sort
    OR c.collector_sort IS DISTINCT FROM s.collector_sort
  );
ALTER TABLE public.marketplace_search_candidates
  ENABLE TRIGGER marketplace_search_candidates_pokedex_sort_upd;
SELECT public.marketplace_refresh_artwork_cluster_sort(NULL);
SELECT count(*) FILTER (WHERE pokedex_sort > 0) AS ranked,
       count(*) AS total
FROM public.marketplace_search_candidates;
`);

console.log(applied.replace(/COPY \d+\n/g, '').trim());
