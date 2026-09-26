import releases from './set-release-languages.json' with { type: 'json' };

/** Western listing codes. Asian printings are other cards, not languages of this set. */
export const WESTERN_SELL_LANGS = ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU'];

const SELL_ORDER = ['EN', 'IT', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU', 'JP', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI'];

const PRINT_LANG = {
  japanese: ['JP'],
  korean: ['JP'],
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
  return SELL_ORDER.filter((code) => have.has(code) && code !== 'KO');
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
 * Languages a seller can list this printing in.
 * TCGdex release rows win, then the printing nationality.
 */
export function sellLanguages({ nationality, setName, releaseLanguages } = {}) {
  const fromCard = cleanCodes(releaseLanguages);
  if (fromCard.length) return rank(fromCard);
  const printed = PRINT_LANG[String(nationality || '').toLowerCase()];
  if (printed) return printed.slice();
  const fromSet = releaseLanguagesForSet(setName);
  if (fromSet) return rank(fromSet);
  return WESTERN_SELL_LANGS.slice();
}

/**
 * Asian codes that are a different printing of the same artwork.
 * Choosing one confirms a redirect instead of listing this card in that language.
 */
export function versionRedirects(printings, currentId, listed) {
  const rows = printings || [];
  const current = String(currentId || '');
  const have = new Set(cleanCodes(listed));
  const out = [];
  for (const [code, spec] of Object.entries(REDIRECT)) {
    if (have.has(code)) continue;
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
