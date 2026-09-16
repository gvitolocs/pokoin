#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  UI_TO_TCGDEX,
  cardNameRowsForCatalog,
  compactText,
  expansionRowsForCatalog,
  foreignNameDictionary,
  indexSets,
  mergeDictionaries,
  nameDictionaryFromLanguageDumps,
  parsePokeApiSpeciesCsv,
  rarityRowsForCatalog,
} = require('./catalog-languages');

const POSTGRES = process.env.POKOIN_MARKETPLACE_POSTGRES || 'pokoin-marketplace-postgres-15t';
const TCGDEX_BASE = (process.env.TCGDEX_BASE_URL || 'https://api.tcgdex.net').replace(/\/+$/, '');
const DEFAULT_CACHE = '/tmp/pokoin-tcgdex-langs';
const DEFAULT_PTCG = '/home/nez/data/pokemon-tcg-data';
const TCGDEX_DUMP_LANGS = [
  'en', 'it', 'fr', 'de', 'es', 'es-mx', 'ja', 'pt', 'pt-br', 'pt-pt',
  'nl', 'pl', 'ru', 'ko', 'zh-cn', 'zh-tw', 'id', 'th',
];
const UI_FILL_ORDER = {
  es: ['es', 'es-mx'],
  pt: ['pt', 'pt-br', 'pt-pt'],
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    pokemontcgDataDir: fs.existsSync(DEFAULT_PTCG) ? DEFAULT_PTCG : '',
    cacheDir: process.env.TCGDEX_CACHE_DIR || DEFAULT_CACHE,
    tcgdexBaseUrl: TCGDEX_BASE,
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    const value = rest.join('=');
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (key === 'pokemontcg-data-dir') options.pokemontcgDataDir = value;
    else if (key === 'cache-dir') options.cacheDir = value;
    else if (key === 'tcgdex-base-url') options.tcgdexBaseUrl = String(value || '').replace(/\/+$/, '') || TCGDEX_BASE;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

async function fetchJson(url, { retries = 7 } = {}) {
  let last = '';
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'PokoinCatalogLanguages/1.0' },
    });
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    last = `${response.status} ${url}`;
    if (response.status === 429 || response.status >= 500) {
      await sleep(Math.min(30_000, 750 * 2 ** attempt));
      continue;
    }
    throw new Error(last);
  }
  throw new Error(`retries exhausted: ${last}`);
}

async function cachedJson(cacheDir, key, url) {
  const file = path.join(cacheDir, `${key}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const data = await fetchJson(url);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

async function cachedJsonText(cacheDir, filename, url) {
  const file = path.join(cacheDir, filename);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8');
  }
  const response = await fetch(url, {
    headers: { 'user-agent': 'PokoinCatalogLanguages/1.0' },
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const text = await response.text();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

function psql(sql) {
  const result = spawnSync(
    'docker',
    [
      'exec', '-i', POSTGRES,
      'psql', '-U', 'pokoin_marketplace', '-d', 'pokoin_marketplace',
      '-v', 'ON_ERROR_STOP=1', '-At',
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `psql exit ${result.status}`).trim());
  }
  return result.stdout;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === ',') {
      out.push(current);
      current = '';
    } else if (char === '"') {
      quoted = true;
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function parseCsv(text) {
  return String(text || '')
    .split(/\n/)
    .filter(Boolean)
    .map(parseCsvLine);
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function copyUpsert(table, columns, rows, conflictCols, updateCols) {
  if (!rows.length) return 0;
  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    const key = conflictCols.map((col) => row[col]).join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const stage = `${table}_stage`;
  const csv = unique.map((row) => columns.map((col) => csvEscape(row[col])).join(',')).join('\n');
  const updates = updateCols.map((col) => `${col} = excluded.${col}`).join(',\n      ');
  const sql = `
begin;
create temp table ${stage} (like public.${table} including defaults);
copy ${stage} (${columns.join(', ')}) from stdin with (format csv);
${csv}
\\.
insert into public.${table} (${columns.join(', ')})
select ${columns.join(', ')} from ${stage}
on conflict (${conflictCols.join(', ')}) do update set
      ${updates},
      updated_at = now();
commit;
`;
  psql(sql);
  return unique.length;
}

function loadCatalogNames() {
  const text = psql(`
copy (
  select distinct name
  from public.pokoin_pokemon_blueprints
  where coalesce(btrim(name), '') <> ''
  order by 1
) to stdout with (format csv);
`);
  return parseCsv(text).map((row) => row[0]).filter(Boolean);
}

function loadCatalogExpansions() {
  const text = psql(`
copy (
  select expansion_id, name, coalesce(official_id, ''), coalesce(official_name, ''), coalesce(code, '')
  from public.pokoin_pokemon_expansions
  where expansion_id is not null
  order by expansion_id
) to stdout with (format csv);
`);
  return parseCsv(text).map(([expansionId, name, officialId, officialName, code]) => ({
    expansionId: Number(expansionId),
    name,
    officialId,
    officialName,
    code,
  }));
}

function loadCatalogRarities() {
  const text = psql(`
copy (
  select distinct trim(split_part(coalesce(nullif(c.card_number, ''), coalesce(b.version, '')), '|', 1))
  from public.marketplace_cards c
  join public.pokoin_pokemon_blueprints b on b.id = c.ct_id
) to stdout with (format csv);
`);
  return [...new Set(parseCsv(text).map((row) => row[0]).map((value) => value.trim()).filter(Boolean))];
}

function loadPokemontcgCards(dir) {
  const cardsDir = path.join(dir, 'cards', 'en');
  if (!dir || !fs.existsSync(cardsDir)) return [];
  const cards = [];
  for (const file of fs.readdirSync(cardsDir).filter((name) => name.endsWith('.json'))) {
    const rows = JSON.parse(fs.readFileSync(path.join(cardsDir, file), 'utf8'));
    for (const card of rows || []) {
      if (Array.isArray(card?.foreignNames) && card.foreignNames.length) cards.push(card);
    }
  }
  return cards;
}

function loadPokemontcgSets(dir) {
  const file = path.join(dir, 'sets', 'en.json');
  if (!dir || !fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addSetNameAliases(setIndex, aliasSets) {
  for (const set of aliasSets || []) {
    const id = String(set?.id || '').trim().toLowerCase();
    const key = compactText(set?.name);
    if (!id || !key) continue;
    const existing = setIndex.byId.get(id);
    if (!existing) continue;
    const bucket = setIndex.byCompact.get(key) || [];
    if (!bucket.some((entry) => entry.id === existing.id)) {
      bucket.push(existing);
      setIndex.byCompact.set(key, bucket);
    }
  }
}

async function downloadTcgdexDumps(options) {
  const dumps = { cards: new Map(), sets: new Map(), rarities: [] };
  for (const lang of TCGDEX_DUMP_LANGS) {
    process.stderr.write(`tcgdex ${lang} cards+sets\n`);
    const cards = await cachedJson(
      options.cacheDir,
      `cards-${lang}`,
      `${options.tcgdexBaseUrl}/v2/${lang}/cards`,
    );
    const sets = await cachedJson(
      options.cacheDir,
      `sets-${lang}`,
      `${options.tcgdexBaseUrl}/v2/${lang}/sets`,
    );
    dumps.cards.set(lang, Array.isArray(cards) ? cards : []);
    dumps.sets.set(lang, Array.isArray(sets) ? sets : []);
  }
  dumps.rarities = await cachedJson(
    options.cacheDir,
    'rarities-en',
    `${options.tcgdexBaseUrl}/v2/en/rarities`,
  ) || [];
  return dumps;
}

function dictionariesFromDumps(dumps, pokemontcgCards) {
  const englishCards = dumps.cards.get('en') || [];
  const byUi = new Map();
  for (const [ui, tcgdexLang] of Object.entries(UI_TO_TCGDEX)) {
    if (ui === 'en') continue;
    const order = UI_FILL_ORDER[ui] || [tcgdexLang];
    let dict = new Map();
    for (const lang of order) {
      const localized = dumps.cards.get(lang) || [];
      dict = mergeDictionaries(dict, nameDictionaryFromLanguageDumps(englishCards, localized, 'tcgdex'));
    }
    const ptcg = foreignNameDictionary(pokemontcgCards, ui);
    byUi.set(ui, mergeDictionaries(dict, ptcg));
  }
  return byUi;
}

function setIndexesFromDumps(dumps, pokemontcgSets) {
  const english = indexSets([
    ...(dumps.sets.get('en') || []),
    ...(dumps.sets.get('ja') || []),
    ...(dumps.sets.get('zh-cn') || []),
    ...(dumps.sets.get('zh-tw') || []),
    ...(dumps.sets.get('ko') || []),
  ]);
  addSetNameAliases(english, pokemontcgSets);
  const byUi = new Map();
  for (const [ui, tcgdexLang] of Object.entries(UI_TO_TCGDEX)) {
    if (ui === 'en') continue;
    const order = UI_FILL_ORDER[ui] || [tcgdexLang];
    let sets = indexSets([]);
    for (const lang of order) {
      const extra = indexSets(dumps.sets.get(lang) || []);
      for (const [id, entry] of extra.byId) {
        if (!sets.byId.has(id)) sets.byId.set(id, entry);
      }
    }
    byUi.set(ui, sets);
  }
  return { english, byUi };
}

async function localizedRaritiesFromTcgdex(options, englishRarities) {
  const limit = createLimiter(4);
  const byUi = new Map();
  for (const ui of Object.keys(UI_TO_TCGDEX)) {
    if (ui !== 'en') byUi.set(ui, new Map());
  }
  for (const rarity of englishRarities || []) {
    const list = await cachedJson(
      options.cacheDir,
      `rarity-cards-${Buffer.from(rarity).toString('base64url')}`,
      `${options.tcgdexBaseUrl}/v2/en/cards?rarity=${encodeURIComponent(rarity)}`,
    );
    const samples = (Array.isArray(list) ? list : []).slice(0, 12).map((card) => String(card?.id || '')).filter(Boolean);
    if (!samples.length) continue;
    const jobs = Object.entries(UI_TO_TCGDEX)
      .filter(([ui]) => ui !== 'en')
      .map(([ui, lang]) => limit(async () => {
        for (const sampleId of samples) {
          const card = await cachedJson(
            options.cacheDir,
            `card-${lang}-${sampleId}`,
            `${options.tcgdexBaseUrl}/v2/${lang}/cards/${encodeURIComponent(sampleId)}`,
          );
          const localized = String(card?.rarity || '').trim();
          if (localized) {
            byUi.get(ui).set(rarity, localized);
            return;
          }
        }
      }));
    await Promise.all(jobs);
    process.stderr.write(`tcgdex rarity ${rarity} → ${samples[0]}\n`);
  }
  return byUi;
}

async function main() {
  const options = parseArgs();
  fs.mkdirSync(options.cacheDir, { recursive: true });

  const names = loadCatalogNames();
  const expansions = loadCatalogExpansions();
  const catalogRarities = loadCatalogRarities();
  const pokemontcgCards = loadPokemontcgCards(options.pokemontcgDataDir);
  const pokemontcgSets = loadPokemontcgSets(options.pokemontcgDataDir);

  process.stderr.write(
    `catalog names=${names.length} expansions=${expansions.length} rarities=${catalogRarities.length} ptcg-foreign=${pokemontcgCards.length}\n`,
  );

  const dumps = await downloadTcgdexDumps(options);
  const speciesCsv = await cachedJsonText(
    options.cacheDir,
    'pokemon_species_names.csv',
    'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv',
  );
  const speciesByCompact = parsePokeApiSpeciesCsv(speciesCsv);
  const nameDicts = dictionariesFromDumps(dumps, pokemontcgCards);
  const setIndexes = setIndexesFromDumps(dumps, pokemontcgSets);
  const rarityDicts = await localizedRaritiesFromTcgdex(options, dumps.rarities);

  const cardRows = cardNameRowsForCatalog(names, nameDicts, speciesByCompact);
  const rarityRows = rarityRowsForCatalog(catalogRarities, dumps.rarities, rarityDicts);
  const expansionRows = expansionRowsForCatalog(expansions, setIndexes.english, setIndexes.byUi);

  const summary = {
    card_name_languages: cardRows.length,
    card_name_translated: cardRows.filter((row) => row.language !== 'en').length,
    rarity_languages: rarityRows.length,
    rarity_translated: rarityRows.filter((row) => row.language !== 'en').length,
    expansion_languages: expansionRows.length,
    expansion_translated: expansionRows.filter((row) => row.language !== 'en').length,
    apply: options.apply,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!options.apply) return summary;

  copyUpsert(
    'card_name_languages',
    ['name', 'language', 'localized_name', 'source', 'source_id'],
    cardRows.map((row) => ({
      name: row.name,
      language: row.language,
      localized_name: row.localizedName,
      source: row.source,
      source_id: row.sourceId,
    })),
    ['name', 'language'],
    ['localized_name', 'source', 'source_id'],
  );
  copyUpsert(
    'rarity_languages',
    ['rarity', 'language', 'localized_name', 'source', 'source_id'],
    rarityRows.map((row) => ({
      rarity: row.rarity,
      language: row.language,
      localized_name: row.localizedName,
      source: row.source,
      source_id: row.sourceId,
    })),
    ['rarity', 'language'],
    ['localized_name', 'source', 'source_id'],
  );
  copyUpsert(
    'expansion_languages',
    ['expansion_id', 'language', 'localized_name', 'source', 'source_id'],
    expansionRows.map((row) => ({
      expansion_id: row.expansionId,
      language: row.language,
      localized_name: row.localizedName,
      source: row.source,
      source_id: row.sourceId,
    })),
    ['expansion_id', 'language'],
    ['localized_name', 'source', 'source_id'],
  );
  return summary;
}

module.exports = {
  addSetNameAliases,
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}
