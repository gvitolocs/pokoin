import { useSyncExternalStore } from 'react';

const KEY = 'pokoin.searchLanguage';

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
export const SEARCH_LANG_RE = 'en|it|fr|de|es|jp|pt|nl|pl|ru|ko|zht|zh|id|th|vi';
const CATALOG_PATH = new RegExp(`^(/marketplace/)(${SEARCH_LANG_RE})(/(?:cards|artists)/)`);

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
  const lang = isSearchLang(code) ? String(code).toLowerCase() : 'en';
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}flags/${lang}.svg`;
}

export function langMeta(code) {
  return SEARCH_LANGS.find((row) => row.code === code) || SEARCH_LANGS[0];
}
