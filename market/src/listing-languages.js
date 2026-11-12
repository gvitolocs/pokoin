import releases from './set-release-languages.json' with { type: 'json' };

/** Western listing codes. Asian printings are other cards, not languages of this set. */
export const WESTERN_SELL_LANGS = ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU'];

/**
 * Every western printing can be listed in these. TCGdex release rows only say
 * which languages TCGdex has data for — Plasma Blast has no ES there, yet
 * CardTrader sellers list Spanish copies — so they only add NL/PL/RU.
 */
const WESTERN_CORE_LANGS = ['EN', 'IT', 'FR', 'DE', 'ES', 'PT'];

const SELL_ORDER = ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU', 'JP', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI'];

/** Japanese and Korean printings list every other Asian language except Chinese. */
const ASIAN_SELL_LANGS = ['JP', 'KO', 'ID', 'TH', 'VI'];

const PRINT_LANG = {
  japanese: ASIAN_SELL_LANGS,
  korean: ASIAN_SELL_LANGS,
  chinese: ['ZH', 'ZHT'],
  indonesian: ['ID'],
  thai: ['TH'],
  idth: ['ID', 'TH'],
};

const REDIRECT = {
  JP: { nationality: 'japanese', label: 'Japanese' },
  ZH: { nationality: 'chinese', label: 'Chinese' },
  ZHT: { nationality: 'chinese', label: 'Traditional Chinese' },
};

function cleanCodes(codes) {
  const known = new Set(SELL_ORDER);
  return [...new Set((codes || []).map((code) => String(code || '').trim().toUpperCase()).filter((code) => known.has(code)))];
}

function rank(codes) {
  const have = new Set(codes);
  return SELL_ORDER.filter((code) => have.has(code));
}

export function setReleaseKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Languages TCGdex has published for this set id or English set name. */
export function releaseLanguagesForSet(setName) {
  const key = setReleaseKey(setName);
  if (!key) return null;
  const exact = releases[key];
  if (Array.isArray(exact) && exact.length) return exact.slice();
  const last = key.split(' ').at(-1);
  if (last && last !== key && last.length >= 3) {
    const tail = releases[last];
    if (Array.isArray(tail) && tail.length) return tail.slice();
  }
  return null;
}

/**
 * Languages a seller can list this printing in. Asian printings follow their
 * nationality; western ones get EN/IT/FR/DE/ES/PT plus any NL/PL/RU release.
 */
export function sellLanguages({ nationality, setName, releaseLanguages } = {}) {
  const printed = PRINT_LANG[String(nationality || '').toLowerCase()];
  if (printed) return rank(printed);
  const fromCard = cleanCodes(releaseLanguages);
  const released = fromCard.length ? fromCard : cleanCodes(releaseLanguagesForSet(setName));
  if (!released.length) return WESTERN_SELL_LANGS.slice();
  // A release row of only Asian codes is not a western printing's languages.
  const western = released.filter((code) => WESTERN_SELL_LANGS.includes(code));
  if (!western.length) return rank(released);
  return rank([...WESTERN_CORE_LANGS, ...western]);
}

/**
 * Desk language chips: what this printing can exist in, plus a language the
 * caller has real data for (a listing, a sale, a buy order). What the visitor
 * reads is not data: an English desk of a Chinese card offers ZH and ZHT.
 */
export function deskLanguageChips({ nationality, setName, releaseLanguages, data } = {}) {
  const codes = sellLanguages({ nationality, setName, releaseLanguages });
  const extra = cleanCodes(data).filter((code) => !codes.includes(code));
  return [...codes, ...rank(extra)];
}

/**
 * Chip the desk opens on: `chosen` (the URL, or the visitor's own language)
 * when this printing exists in it, else the first chip with data, else the
 * printing's first language — ZH for a Chinese one, EN for a western one.
 */
export function deskLanguageChoice({ nationality, setName, releaseLanguages, data, chosen } = {}) {
  const chips = deskLanguageChips({ nationality, setName, releaseLanguages, data });
  const have = new Set(cleanCodes(data));
  const want = String(chosen || '').trim().toUpperCase();
  if (chips.includes(want)) return want;
  return chips.find((code) => have.has(code)) || chips[0];
}

/**
 * Asian codes that are a different printing of the same artwork.
 * Choosing one confirms a redirect instead of listing this card in that language.
 */
export function versionRedirects(printings, currentId, listed, options = {}) {
  const rows = printings || [];
  const current = String(currentId || '');
  const have = new Set(cleanCodes(listed));
  const nation = String(options.nationality || '').toLowerCase();
  const hideChinese = nation === 'japanese' || nation === 'korean';
  const out = [];
  for (const [code, spec] of Object.entries(REDIRECT)) {
    if (have.has(code)) continue;
    if (hideChinese && (code === 'ZH' || code === 'ZHT')) continue;
    const candidates = rows.filter((row) => {
      const id = String(row?.id || row?.card_id || '');
      if (!id || id === current) return false;
      const nation = String(row?.nationality || '').toLowerCase();
      return nation === spec.nationality || (spec.nationality === 'japanese' && nation === 'korean');
    });
    const target = candidates.find((row) => String(row?.nationality || '').toLowerCase() === spec.nationality)
      || candidates[0];
    if (target) out.push({ code, label: spec.label, card: target });
  }
  return out;
}
