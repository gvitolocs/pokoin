/**
 * Card scan in the visitor's card language (docs/CARD_LANGUAGE_SCANS.md).
 *
 * A western printing is one CardTrader blueprint for every western language,
 * so its leftover JPEG is the English scan. Card rows from the API carry
 * `langScans: "de,fr,it:swsh/swsh3/136"` when TCGdex has the same card in
 * other languages (scripts/sql/129). With Italian picked in the language
 * menu, the tile and desk show cdn.pokoin.com/tcgdex/it/swsh/swsh3/136.webp
 * first and fall back to the leftover JPEG when it fails. English, Japanese
 * and Korean keep the leftover scan: those are their own printings.
 */
import { CDN_ORIGIN } from './image-urls.js';

export const LANG_SCAN_NAMES = {
  it: 'Italian',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  pt: 'Portuguese',
};

const PATH = /^[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+$/;
const URL_LANG = /\/tcgdex\/(it|fr|de|es|pt)\/[^?#]+\.webp(?:[?#]|$)/;

/** The scan URL for `lang`, or '' when this printing has none in that language. */
export function langScanUrl(langScans, lang) {
  const code = String(lang || '').toLowerCase();
  if (!Object.hasOwn(LANG_SCAN_NAMES, code)) return '';
  const text = String(langScans || '');
  const at = text.indexOf(':');
  if (at <= 0) return '';
  const path = text.slice(at + 1);
  if (!PATH.test(path) || !text.slice(0, at).split(',').includes(code)) return '';
  return `${CDN_ORIGIN}/tcgdex/${code}/${path}.webp`;
}

/** `it` when `url` is a language scan, else ''. */
export function langScanLanguage(url) {
  const match = String(url || '').match(URL_LANG);
  return match ? match[1] : '';
}

/** Desk caption for a painted language scan: "Italian scan". */
export function langScanLabel(url) {
  const lang = langScanLanguage(url);
  return lang ? `${LANG_SCAN_NAMES[lang]} scan` : '';
}
