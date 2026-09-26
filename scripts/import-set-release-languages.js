'use strict';

/**
 * Rebuild market/src/set-release-languages.json from TCGdex, and upsert
 * public.expansion_release_languages when a writer URL is set.
 *
 *   node scripts/import-set-release-languages.js
 *   MARKETPLACE_WRITER_DATABASE_URL=... node scripts/import-set-release-languages.js --apply
 */

const fs = require('fs');
const path = require('path');

const LANGS = [
  ['en', 'EN'], ['fr', 'FR'], ['de', 'DE'], ['it', 'IT'], ['es', 'ES'],
  ['pt-br', 'PT'], ['nl', 'NL'], ['pl', 'PL'], ['ru', 'RU'],
  ['ja', 'JP'], ['ko', 'KO'], ['zh-cn', 'ZH'], ['zh-tw', 'ZHT'],
  ['id', 'ID'], ['th', 'TH'],
];
const ORDER = ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU', 'JP', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI'];

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rank(codes) {
  const have = new Set(codes);
  return ORDER.filter((code) => have.has(code));
}

async function loadIndex(lang) {
  const response = await fetch(`https://api.tcgdex.net/v2/${lang}/sets`);
  if (!response.ok) throw new Error(`${lang} ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error(`${lang} was not a set list`);
  return rows;
}

async function main() {
  const byId = new Map();
  const names = new Map();
  for (const [lang, code] of LANGS) {
    const rows = await loadIndex(lang);
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id).add(code);
      if (lang === 'en' && row.name) names.set(id, row.name);
    }
    console.log(`${lang} ${rows.length}`);
  }

  const out = {};
  for (const [id, codes] of byId) {
    const ranked = rank(codes);
    out[norm(id)] = ranked;
    const name = names.get(id);
    if (name) out[norm(name)] = ranked;
  }
  const dest = path.join(__dirname, '..', 'market', 'src', 'set-release-languages.json');
  fs.writeFileSync(dest, `${JSON.stringify(out)}\n`);
  console.log(`wrote ${Object.keys(out).length} keys`);

  if (!process.argv.includes('--apply')) return;
  const url = process.env.MARKETPLACE_WRITER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set MARKETPLACE_WRITER_DATABASE_URL to write the table');
    process.exit(1);
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(`
      select expansion_id, name
      from public.pokoin_pokemon_expansions
      where name is not null and name <> ''
    `);
    let written = 0;
    for (const row of rows) {
      const langs = out[norm(row.name)];
      if (!langs) continue;
      for (const language of langs) {
        await client.query(`
          insert into public.expansion_release_languages (expansion_id, language, source, source_id)
          values ($1, $2, 'tcgdex', $3)
          on conflict (expansion_id, language) do update
            set source = excluded.source,
                source_id = excluded.source_id,
                updated_at = now()
        `, [row.expansion_id, language, row.name]);
        written += 1;
      }
    }
    console.log(`upserted ${written} release-language rows`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
