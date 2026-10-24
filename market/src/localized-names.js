/**
 * Localized card names for the typeahead (title language ≠ English).
 *
 * The local name pool and the search index are English identity (D00001H):
 * a localized query (`evoli`, `glurak`, `イーブイ`, `伊布`) fuzzy-matched
 * unrelated English names (Evolution Incense, Golurk) and the server found
 * nothing. Under a non-English search language the typed name is ranked
 * against both the English pool and that language's catalog names
 * (card_name_languages, scripts/export-localized-names.sh). When a localized
 * row scores best, the name part of the query is rewritten to its English
 * name, so recall, ranking and Enter all work on the English identity while
 * rows still show the localized subtitle from the server overlay (D00001T).
 *
 * Each language is its own lazy chunk; until it lands the query is used as
 * typed. English never loads a table and is never rewritten.
 */

import { compactQuery } from './compact-query.js';
import { NAME_POOL, parseTypedQuery, rankNames } from './suggest-rank.js';

const LOADERS = {
  de: () => import('./data/localized-names/de.js'),
  es: () => import('./data/localized-names/es.js'),
  fr: () => import('./data/localized-names/fr.js'),
  it: () => import('./data/localized-names/it.js'),
  jp: () => import('./data/localized-names/jp.js'),
  ko: () => import('./data/localized-names/ko.js'),
  pt: () => import('./data/localized-names/pt.js'),
  zh: () => import('./data/localized-names/zh.js'),
  zht: () => import('./data/localized-names/zht.js'),
};

const pools = new Map();
const loading = new Map();

function normLang(lang) {
  return String(lang || 'en').toLowerCase();
}

/** Hiragana → katakana, so `いーぶい` finds `イーブイ`. Other scripts unchanged. */
function foldKana(text) {
  return String(text || '').replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

let priors = null;
function priorOf(english) {
  if (!priors) {
    priors = new Map(NAME_POOL.map((row) => [row.compact, row.prior]));
  }
  return priors.get(compactQuery(english)) || 1;
}

/**
 * `rows` are [localized, english] pairs. Pool rows rank like NAME_POOL rows
 * (display = the localized name, prior = the English name's printing count)
 * and carry the English name in `slug` so it survives rankNames.
 */
export function buildLocalizedPool(rows) {
  const pool = [];
  const exact = new Map();
  const seen = new Set();
  for (const [localized, english] of rows || []) {
    const compact = compactQuery(foldKana(localized));
    if (!compact || !english || compact === compactQuery(english)) continue;
    const key = `${compact}\0${english}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { display: String(localized), compact, prior: priorOf(english), slug: String(english) };
    pool.push(row);
    // One localized title can name several English blueprints (`Dracaufeu-ex`
    // is Charizard EX and Charizard ex): the most printed one answers.
    if (!exact.has(compact) || exact.get(compact).prior < row.prior) exact.set(compact, row);
  }
  return { rows: pool, exact };
}

let englishCompacts = null;
function isEnglishName(compact) {
  englishCompacts ||= new Set(NAME_POOL.map((row) => row.compact));
  return englishCompacts.has(compact);
}

/**
 * Longest leading word span that is exactly a localized name (and not an
 * English one): `evoli sir` → `Eevee sir`, `eevee radiante` (it) → `Radiant
 * Eevee`. The words after it stay for the set / number / rarity readers.
 */
function exactSpanQuery(raw, table) {
  const words = raw.split(/\s+/).filter(Boolean);
  for (let k = words.length; k >= 1; k -= 1) {
    const compact = compactQuery(foldKana(words.slice(0, k).join(' ')));
    const row = table.exact.get(compact);
    if (row && !isEnglishName(compact)) return [row.slug, ...words.slice(k)].join(' ');
  }
  return '';
}

/** Install a table directly (tests, prewarmed data). */
export function setLocalizedNames(lang, rows) {
  pools.set(normLang(lang), buildLocalizedPool(rows));
  englishMemo.clear();
}

export function hasLocalizedNames(lang) {
  return Object.hasOwn(LOADERS, normLang(lang));
}

export function localizedNamesReady(lang) {
  const code = normLang(lang);
  return !hasLocalizedNames(code) || pools.has(code);
}

/** Resolves true once `lang`'s table is usable (always true for English / unknown codes). */
export function loadLocalizedNames(lang) {
  const code = normLang(lang);
  if (localizedNamesReady(code)) return Promise.resolve(true);
  if (!loading.has(code)) {
    loading.set(code, LOADERS[code]()
      .then((mod) => {
        pools.set(code, buildLocalizedPool(mod.default));
        englishMemo.clear();
        return true;
      })
      .catch(() => false)
      .finally(() => loading.delete(code)));
  }
  return loading.get(code);
}

/** Drop the typed name words from `query` once each; what is left is set / number / rarity text. */
function remainderWords(query, nameQuery) {
  const pending = String(nameQuery || '').trim().split(/\s+/).map(compactQuery).filter(Boolean);
  const rest = [];
  for (const word of String(query || '').trim().split(/\s+/)) {
    const at = pending.indexOf(compactQuery(word));
    if (at >= 0) {
      pending.splice(at, 1);
      continue;
    }
    if (word) rest.push(word);
  }
  return rest;
}

const englishMemo = new Map();
const ENGLISH_MEMO_MAX = 64;

/**
 * The query with its localized card name rewritten to English, or '' when it
 * should be used as typed (English, table not loaded, no localized name wins).
 *
 *   englishQuery('evoli', 'fr')         → 'Eevee'
 *   englishQuery('dracaufeu ex', 'fr')  → 'Charizard ex'
 *   englishQuery('evoli sir', 'fr')     → 'Eevee sir'
 *   englishQuery('pikachu', 'fr')       → ''  (the English name wins)
 */
export function englishQuery(query, lang) {
  const code = normLang(lang);
  const table = pools.get(code);
  const raw = String(query || '').trim();
  if (code === 'en' || !table?.rows.length || !raw) return '';
  const memoKey = `${code}\0${raw}`;
  if (englishMemo.has(memoKey)) return englishMemo.get(memoKey);
  let out = exactSpanQuery(raw, table);
  const parsed = out ? null : parseTypedQuery(raw);
  const nameQuery = parsed ? String(parsed.nameQuery || raw).trim() : '';
  // Still typing or misspelt (`dracau`, `dracofeu`, `イーブ`): the same typo
  // and prefix ranking as the English pool, over this language's names.
  if (!out && compactQuery(nameQuery)) {
    const local = rankNames(foldKana(nameQuery), table.rows, { fill: 1 })[0];
    const englishRows = rankNames(nameQuery, NAME_POOL);
    const english = englishRows[0];
    const englishPrior = Math.max(0, ...englishRows
      .filter((row) => row.withinCap === true && row.distance === 0).map((row) => row.prior));
    // A localized name must be an accepted match and beat the best English
    // reading: `pikachu` / `mew` (same or English-only) stay as typed. When the
    // text already starts an English name (`char`, `dra`), English names stay
    // first-class: a localized prefix (`Charbi`, `Draco`) wins only for a more
    // printed card (`evol` → Évoli beats Evolution Incense).
    const englishPrefix = english?.withinCap === true && english.distance === 0;
    const wins = englishPrefix
      ? local?.distance === 0 && local.prior > englishPrior
      : (!english?.withinCap || local?.score > english.score);
    if (local?.withinCap === true && local.slug && wins
      && compactQuery(local.slug) !== compactQuery(nameQuery)) {
      out = [local.slug, ...remainderWords(raw, nameQuery)].join(' ');
    }
  }
  englishMemo.set(memoKey, out);
  if (englishMemo.size > ENGLISH_MEMO_MAX) englishMemo.delete(englishMemo.keys().next().value);
  return out;
}

/** Test hook. */
export function resetLocalizedNames() {
  pools.clear();
  loading.clear();
  englishMemo.clear();
}
