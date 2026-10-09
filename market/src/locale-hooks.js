// React bindings for the language stores in locale.js. locale.js itself stays
// framework-free so non-React apps can reuse it.

import { useSyncExternalStore } from 'react';
import { getPrintLang, getSearchLang, subscribePrintLang, subscribeSearchLang } from './locale.js';

export function useSearchLang() {
  return useSyncExternalStore(subscribeSearchLang, getSearchLang, () => 'en');
}

export function usePrintLang() {
  return useSyncExternalStore(subscribePrintLang, getPrintLang, () => 'all');
}
