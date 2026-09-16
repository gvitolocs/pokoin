import { useSyncExternalStore } from 'react';

const KEY = 'pokoin.searchLanguage';
const PRINT_KEY = 'pokoin.printLanguage';

/** TCG search languages. Flags: HatScripts/circle-flags (MIT), vendored in public/flags. */
export const SEARCH_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'jp', label: 'Japanese' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Russian' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'zht', label: 'Chinese (Traditional)' },
  { code: 'id', label: 'Indonesia' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
];

const CODES = new Set(SEARCH_LANGS.map((row) => row.code));
/** Print-region flags that are not TCG search langs. */
const PRINT_FLAG_CODES = new Set(['jp', 'zh', 'eu', 'us', 'euus', 'jpko', 'idth']);
/** Western combined mark is SVG; EU-only print uses the PNG raster. */
const FLAG_FILE = {
  eu: 'eu.png',
  us: 'us.svg',
  euus: 'euus.svg',
  jpko: 'jpko.svg',
  idth: 'idth.svg',
};
export const SEARCH_LANG_RE = 'en|it|fr|de|es|jp|pt|nl|pl|ru|ko|zht|zh|id|th|vi';
const CATALOG_PATH = new RegExp(`^(/marketplace/)(${SEARCH_LANG_RE})(/(?:cards|artists|users)/)`);

const listeners = new Set();
let current = readStored();

function readStored() {
  try {
    const stored = localStorage.getItem(KEY);
    if (CODES.has(stored)) {
      return stored;
    }
  } catch {
    /* private mode */
  }
  return 'en';
}

function emit() {
  listeners.forEach((fn) => fn());
}

export function isSearchLang(code) {
  return CODES.has(String(code || '').toLowerCase());
}

export function getSearchLang() {
  return current;
}

export function setSearchLang(code) {
  const next = isSearchLang(code) ? String(code).toLowerCase() : 'en';
  if (next === current) {
    return current;
  }
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode */
  }
  emit();
  return current;
}

export function subscribeSearchLang(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSearchLang() {
  return useSyncExternalStore(subscribeSearchLang, getSearchLang, () => 'en');
}

export function searchLangFromPath(pathname) {
  const match = String(pathname || '').match(new RegExp(`^/marketplace/(${SEARCH_LANG_RE})(?:/|$)`));
  return match ? match[1] : '';
}

export function rewriteCatalogLang(pathname, nextLang) {
  const next = isSearchLang(nextLang) ? String(nextLang).toLowerCase() : 'en';
  const path = String(pathname || '');
  if (!CATALOG_PATH.test(path)) {
    return path;
  }
  return path.replace(CATALOG_PATH, `$1${next}$3`);
}

export function flagSrc(code) {
  const raw = String(code || '').toLowerCase();
  const lang = isSearchLang(raw) || PRINT_FLAG_CODES.has(raw) ? raw : 'en';
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  const file = FLAG_FILE[lang] || `${lang}.svg`;
  return `${base}flags/${file}`;
}

/** Print flag from `pokoin_pokemon_expansions.nationality`.
 * Japanese → JP+KO (`jpko.svg`), Korean → Taegeukgi (`ko.svg`), Chinese → CN
 * (`zh.svg`), western → US+EU (`euus.svg`), Indonesian → `id.svg`, Thai →
 * `th.svg`, mixed ID+TH → `idth.svg`, French → `fr.svg`, German → `de.svg`,
 * American → `us.svg`. `jp.svg` stays the title-language chip. EU-only print
 * is `eu.png`. Product: none. Used on search-suggest (desktop: left of
 * `.suggest-art`; phone: overlay on that crop), the set desk title
 * (left of `h1.page-title`), Sets / Era catalog tiles
 * (left of `.set-guide-card` name), and artist-desk print chips
 * (`ARTIST_PRINT_FLAGS`: euus / jpko / zh / id; Korean print sits on jpko). */
export function printFlagFromNationality(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  if (value === 'japanese') {
    return { code: 'jpko', label: 'Japanese print' };
  }
  if (value === 'chinese') {
    return { code: 'zh', label: 'Chinese print' };
  }
  if (value === 'korean') {
    return { code: 'ko', label: 'Korean print' };
  }
  if (value === 'european' || value === 'eu') {
    return { code: 'eu', label: 'European print' };
  }
  if (value === 'american' || value === 'us') {
    return { code: 'us', label: 'English print' };
  }
  if (value === 'western') {
    return { code: 'euus', label: 'Western print' };
  }
  if (value === 'indonesian') {
    return { code: 'id', label: 'Indonesian print' };
  }
  if (value === 'thai') {
    return { code: 'th', label: 'Thai print' };
  }
  if (value === 'idth') {
    return { code: 'idth', label: 'Indonesian / Thai print' };
  }
  if (value === 'french' || value === 'fr') {
    return { code: 'fr', label: 'French print' };
  }
  if (value === 'german' || value === 'de') {
    return { code: 'de', label: 'German print' };
  }
  return null;
}

/** TCG listing / sold-graph languages that belong on JP/KO print lines. */
export const ASIAN_CARD_LANGS = ['JP', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI'];

export function usesAsianCardLanguages(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  return value === 'japanese' || value === 'korean';
}

export function defaultCardLanguage(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  if (value === 'japanese') {
    return 'JP';
  }
  if (value === 'korean') {
    return 'KO';
  }
  if (value === 'chinese') {
    return 'ZH';
  }
  if (value === 'indonesian' || value === 'idth') {
    return 'ID';
  }
  if (value === 'thai') {
    return 'TH';
  }
  if (value === 'french' || value === 'fr') {
    return 'FR';
  }
  if (value === 'german' || value === 'de') {
    return 'DE';
  }
  return 'EN';
}

export function languagesForNationality(nationality, languages = []) {
  const list = [...new Set(
    (languages || []).map((code) => String(code || '').trim().toUpperCase()).filter(Boolean),
  )];
  if (!usesAsianCardLanguages(nationality)) {
    return list;
  }
  return list.filter((code) => ASIAN_CARD_LANGS.includes(code));
}

/** Sold-graph / listings language param. JP sets fetch JP, not mixed EN+JP All. */
export function cardLanguageQuery(nationality, languages, selected) {
  const allowed = languagesForNationality(nationality, languages);
  const want = String(selected || '').trim().toUpperCase();
  if (allowed.length === 1) {
    return allowed[0];
  }
  if (want && allowed.includes(want)) {
    return want;
  }
  if (!allowed.length && usesAsianCardLanguages(nationality)) {
    return defaultCardLanguage(nationality);
  }
  return '';
}

export function langMeta(code) {
  return SEARCH_LANGS.find((row) => row.code === code) || SEARCH_LANGS[0];
}

/** Card print-region filter in the search pill. Not title language. */
export const PRINT_LANGS = [
  { code: 'all', label: 'All prints' },
  { code: 'western', label: 'Western print', flag: 'euus', tag: 'EN' },
  { code: 'japanese', label: 'Japanese print', flag: 'jpko', tag: 'JP' },
  { code: 'korean', label: 'Korean print', flag: 'ko', tag: 'KO' },
  { code: 'chinese', label: 'Chinese print', flag: 'zh' },
];

const PRINT_CODES = new Set(PRINT_LANGS.map((row) => row.code));
const printListeners = new Set();
let currentPrint = readStoredPrint();

function readStoredPrint() {
  try {
    const stored = localStorage.getItem(PRINT_KEY);
    if (PRINT_CODES.has(stored)) {
      return stored;
    }
  } catch {
    /* private mode */
  }
  return 'all';
}

function emitPrint() {
  printListeners.forEach((fn) => fn());
}

export function getPrintLang() {
  return currentPrint;
}

export function setPrintLang(code) {
  const next = PRINT_CODES.has(code) ? code : 'all';
  if (next === currentPrint) {
    return currentPrint;
  }
  currentPrint = next;
  try {
    localStorage.setItem(PRINT_KEY, next);
  } catch {
    /* private mode */
  }
  emitPrint();
  return currentPrint;
}

export function subscribePrintLang(fn) {
  printListeners.add(fn);
  return () => printListeners.delete(fn);
}

export function usePrintLang() {
  return useSyncExternalStore(subscribePrintLang, getPrintLang, () => 'all');
}

export function printLangMeta(code) {
  return PRINT_LANGS.find((row) => row.code === code) || PRINT_LANGS[0];
}

/** Occidental / Japanese / Korean / Chinese buckets. Empty / product → western.
 * Indonesian / Thai leftovers stay out of Occidental. */
export function printBucket(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  if (value === 'japanese' || value === 'chinese' || value === 'korean') {
    return value;
  }
  if (value === 'indonesian' || value === 'thai' || value === 'idth') {
    return value;
  }
  return 'western';
}

/** Artist desk: EU+US / JP+KO / CN / ID. Korean print sits on jpko. */
export const ARTIST_PRINT_FLAGS = [
  { code: 'western', flag: 'euus', label: 'Western print' },
  { code: 'japanese', flag: 'jpko', label: 'Japanese print' },
  { code: 'chinese', flag: 'zh', label: 'Chinese print' },
  { code: 'indonesian', flag: 'id', label: 'Indonesian print' },
];

export function artistPrintRegion(nationality) {
  const bucket = printBucket(nationality);
  if (bucket === 'japanese' || bucket === 'korean') return 'japanese';
  if (bucket === 'chinese') return 'chinese';
  if (bucket === 'indonesian' || bucket === 'idth') return 'indonesian';
  return 'western';
}

export function filterSuggestByPrintLang(groups, printLang) {
  if (!printLang || printLang === 'all') {
    return groups;
  }
  return (groups || [])
    .map((group) => ({
      ...group,
      printings: (group.printings || []).filter((row) => (
        row?.live === true
        || String(row?.id || row?.card_id || '').startsWith('live:')
        || printBucket(row.nationality) === printLang
      )),
    }))
    .filter((group) => group.printings.length);
}
