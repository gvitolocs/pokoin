#!/usr/bin/env node
// Golden fixtures for the Dart port of the web typeahead engine.
//
//   node docs/handoff/flutter-suggest-dictionary/export-golden.mjs [repoRoot] [outDir]
//
// Runs the real market/src engine (the code the web ships) over a fixed query
// corpus and writes what each step returns. The Dart tests load the same files
// and assert identical results. Read-only on the repo; writes only to outDir
// (default: ./fixtures next to this script). No network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '../../..'));
const outDir = path.resolve(process.argv[3] || path.join(here, 'fixtures'));
const src = path.join(root, 'market/src');
const load = (p) => import(pathToFileURL(path.join(src, p)).href);

const rank = await load('suggest-rank.js');
const catalog = await load('suggest-catalog.js');
const score = await load('search-score.js');
const pool = await load('suggest-pool.js');
const live = await load('suggest-live.js');
const names = (await load('data/suggest-names.js')).default;
const sets = (await load('data/suggest-sets.js')).default;
const artists = (await load('data/suggest-artists.js')).default;
const typos = (await load('data/reddit-pokemon-typos.js')).default;

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e9) / 1e9 : String(x));

// ---- corpus -------------------------------------------------------------------
// Queries named in docs/TYPEAHEAD.md, docs/TYPEAHEAD_AUDIT.md §E, the locked
// decisions in AGENTS.md and the suggest-*.test.js files, plus every prefix of
// a few names (keystroke ladders) and the 2pikabench seed-2 typos.
const named = [
  'pikachu', 'pika', 'pikahc gx', 'pikachu gx', 'pikachu delta species', 'charizard', 'charziard base',
  'mewtow evol', 'mimikyu ex', 'miikyu ex', 'keldeo ex', 'umbreon vmax', 'm charizard ex', 'mega', 'mega r',
  'mega rayquaza', 'charizard gx', 'mimikyu vmax', 'talflamd', 'dawe', 'oi', 'elafon', 'sh1', 'Sh1', 'TG01',
  '061 shieldon', '061/106', '025', '025 pikachu', 'charizard 025/198', 'hgss energy', 'hgss', 'palkai sl',
  'palkia sl', 'palkia legen', 'palkia legend', 'pakia legend', 'Palkia & Dialga Legend', 'palkia and dialga legend',
  'Lugia LEGEND', 'Ho-Oh LEGEND', 'lugia legend', 'dialga legend', 'suicune legend', 'flareon call of legendsd',
  'palkai call of', 'call of', 'expedition', 'expedition pikachu', 'glaceon plasma', 'plasma', 'eevee i',
  'eevee illu', 'sylveon ex il', 'sylveon ex sir', 'charizard sr', 'charizard ur', 'pikachu secret rare',
  'eevee full art', 'arceus platinum', 'kawayod', 'sugimor', 'komiya', 'tomokazu komiya', 'pika yuka',
  'sugimori pika', 'ultraprism', 'base set', 'evolving skies', 'mewtwo mew', 'mew mewtwo gx', 'arceus palkia',
  'charizard braixen', 'reshiram charizard', 'greninja zoroark', 'n zoroark', 'ns zoroark', 'imakuni doduo',
  'flabebe', 'farfetchd', 'type null', 'typenull', 'porygon z', 'ho oh', 'mr mime', 'nidoran f', 'garchomp lvx',
  'origin forme palkia', 'jumbo', 'booster box', 'elite trainer box', 'theme deck', 'switch', 'rare candy',
  'lightning energy', 'mewtwo ev', 'pikachu sv', 'base set pikachugx', 'pikachugx', 'Pokémon Catcher',
  'pokemon catcher', 'ｐｉｋａｃｈｕ', 'Flabébé', 'ピカチュウ', 'palkia p', 'mewtwo e', 'mewtwo ev',
  'mewtwo evo', 'charizard e', 'charizard evol', 'mewtwo ex', 'mewtwo gx', 'mewtwo v', 'eevee heroes', '151',
];
const ladders = ['pikachu', 'charizard', 'umbreon vmax', 'palkia legend'].flatMap(
  (word) => Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1)),
);
const bench = rank.pikabenchCards(rank.NAME_POOL, { count: 10, seed: 2 }).map((row) => row.query);
const reddit = typos.filter((_, i) => i % 7 === 0).slice(0, 15).map((row) => row.typo);
const corpus = [...new Set([...named, ...ladders, ...bench, ...reddit].map((q) => q.trim()).filter(Boolean))];

// ---- step outputs ---------------------------------------------------------------
const rankedRows = (rows, take = 10) => rows.slice(0, take).map((r) => [r.display, round(r.distance), r.withinCap !== false, round(r.score)]);
const parsedView = (p) => ({
  nameQuery: p.nameQuery,
  setTokens: p.setTokens.map((t) => ({ compact: t.compact, eraId: t.eraId || '', prefix: Boolean(t.prefix), slug: t.slug || '', firstSet: (t.setNames || [])[0] || '' })),
  numberTokens: p.numberTokens.map((t) => ({ compact: t.compact, n: t.n, d: t.d, suffix: t.suffix, code: t.code })),
  artTokens: p.artTokens.map((t) => t.compact),
  rarityTokens: p.rarityTokens.map((t) => [t.compact, t.rarity]),
  eras: p.eras,
});

const queries = corpus.map((q) => {
  const parsed = rank.parseTypedQuery(q);
  const intent = catalog.catalogIntent(q);
  const mods = rank.typedModifiers(q);
  return {
    q,
    compact: rank.compactQuery(q),
    maxDistance: rank.maxDistance(rank.compactQuery(q).length),
    mods: mods.mods,
    nameCompact: mods.nameCompact,
    parsed: parsedView(parsed),
    setOnly: rank.isSetOnlyQuery(parsed),
    setAware: rank.isSetAwareQuery(parsed),
    bareCollector: rank.isBareCollectorQuery(parsed),
    rankNames: rankedRows(rank.rankNames(q), 5),
    rankArtists: rankedRows(rank.rankNames(q, catalog.ARTIST_POOL, { fill: 12 }), 1),
    rankSets: rankedRows(rank.rankNames(q, catalog.SET_POOL, { fill: 12 }), 1),
    intent: { kind: intent.kind, display: intent.display || '', slug: intent.slug || '' },
    meiliQuery: rank.typedMeiliQuery(q),
    catalogRecall: pool.catalogRecall(q),
    rankFreeText: score.rankFreeText(q, { limit: 3 }).map((r) => [r.display, round(r.score), r.coverage]),
    earlySetPrefixName: score.earlySetPrefixName(q),
  };
});

// ---- compactQuery: every non-ASCII dictionary display, plus edge strings ----------------
const compactCases = [
  ...names.map((r) => r.display), ...sets.map((r) => r.display), ...artists.map((r) => r.display),
].filter((d) => /[^\x00-\x7f]/.test(d));
compactCases.push('Nidoran ♀', 'Nidoran ♂', 'Pikachu δ Delta Species', 'ＰＩＫＡＣＨＵ', 'ﬁre', 'ビ', 'ビ', 'Pokémon', '');
const compact = compactCases.map((text) => [text, rank.compactQuery(text)]);

// ---- prefixEditDistance: query/name pairs with QWERTY, transpose and indel cases ------------
const pairs = [
  ['pikachu', 'pikachu'], ['pikahc', 'pikachu'], ['oikachu', 'pikachu'], ['talflamd', 'talonflame'],
  ['dawe', 'dawn'], ['dawe', 'dwebble'], ['elafon', 'leafeon'], ['sh1', 'shinx'], ['o', 'onix'],
  ['charziard', 'charizard'], ['mewtow', 'mewtwo'], ['', 'abc'], ['abc', ''], ['qwerty', 'wqerty'],
  ['zzzz', 'pikachu'], ['1', '2'], ['0', 'p'], ['é', 'e'],
];
const distances = pairs.map(([q, n]) => [q, n, round(rank.prefixEditDistance(q, n)), round(rank.prefixEditDistance(q, n, rank.maxDistance(q.length)))]);

// ---- paint: the popup rows from a fixed hydrated cache ------------------------------------
// Seeded from real api.pokoin.com captures already committed for the c1 work.
const fixtureDir = path.join(root, 'docs/handoff/compact-c1/fixtures');
const seedFiles = ['search-charizard.json', 'expansion-base-set.json', 'expansion-destined-rivals.json', 'home-page.json', 'rails-spotlight.json'];
live.resetSuggestLive();
for (const file of seedFiles) {
  const cards = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')).cards || [];
  const slim = cards.map((c) => ({
    id: String(c.id || c.card_id), card_id: String(c.card_id || c.id), name: c.name, set: c.set || c.set_name,
    set_name: c.set_name || c.set, number: c.number || c.card_number, card_number: c.card_number || c.number,
    rarity: c.rarity, artist: c.artist, itemKind: c.itemKind, productType: c.productType, nationality: c.nationality,
  }));
  live.rememberSuggestGroups(catalog.groupsFromCards(slim), { searchLang: 'en' });
}
const paintQueries = ['charizard', 'charizard gx', 'charziard base', 'charizard 4/102', 'pikachu', 'pika', 'mewtwo', 'base set',
  'destined rivals', 'team rocket', 'charizard sr', 'charizard ex', 'blastoise', 'venusaur', 'zard'];
const paint = [];
for (const q of paintQueries) {
  for (const kind of ['', 'singles', 'product']) {
    for (const printLang of ['all', 'japanese']) {
      const groups = live.paintCatalogGroups(q, { kind, printLang, searchLang: 'en' });
      paint.push({ q, kind, printLang, rows: groups.flatMap((g) => g.printings.map((p) => `${g.name}|${p.id || p.card_id}`)) });
    }
  }
}

const meta = {
  generatedBy: 'docs/handoff/flutter-suggest-dictionary/export-golden.mjs',
  node: process.version,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  counts: { names: names.length, sets: sets.length, artists: artists.length, queries: queries.length, compact: compact.length, distances: distances.length, paint: paint.length },
  scoreRounding: 'scores and distances rounded to 1e-9; compare Dart doubles after the same rounding',
  rankedRow: '[display, distance, withinCap, score]',
  seedFiles,
};
fs.mkdirSync(outDir, { recursive: true });
const write = (name, value) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return [name, fs.statSync(file).size];
};
const written = [
  write('meta.json', meta),
  write('queries.json', queries),
  write('compact.json', compact),
  write('distance.json', distances),
  write('paint.json', paint),
];
for (const [name, bytes] of written) console.log(`${name.padEnd(14)} ${(bytes / 1024).toFixed(1)} KB`);
console.log(`total ${(written.reduce((n, [, b]) => n + b, 0) / 1024).toFixed(1)} KB in ${outDir}`);
console.log(JSON.stringify(meta.counts));
