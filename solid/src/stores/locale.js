import {
  getPrintLang,
  getSearchLang,
  subscribePrintLang,
  subscribeSearchLang,
} from '@market/locale.js';
import { fromExternalStore } from '../lib/external.js';

/** Card title language (en/it/jp/…), market/src/locale.js. */
export const searchLang = fromExternalStore(subscribeSearchLang, getSearchLang);

/** Print family chip (all/western/japanese/…), market/src/locale.js. */
export const printLang = fromExternalStore(subscribePrintLang, getPrintLang);
