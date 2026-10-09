import {
  getPrintLang,
  getSearchLang,
  subscribePrintLang,
  subscribeSearchLang,
} from '@market/locale.js';
import { fromExternalStore } from '../lib/external.js';

/** Card title language (en/it/jp/…) — same store the React header writes. */
export const searchLang = fromExternalStore(subscribeSearchLang, getSearchLang);

/** Print family chip (all/western/japanese/…) — same store as React usePrintLang. */
export const printLang = fromExternalStore(subscribePrintLang, getPrintLang);
