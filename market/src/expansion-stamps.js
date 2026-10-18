import { isPokemonGame } from './game.js';

/**
 * Deck printings carry a mascot stamp (Battle Academy Mewtwo/Pikachu/…,
 * Trainer Kit half-deck icons) where the expansion symbol would tell them
 * apart. The chip shows that stamp, not the deck's generic code plate.
 *
 * Plates live on the CDN under expansions/stamps/{key}.png, drawn by
 * tools/expansion-stamps (keys = its stamps.tsv). Publish both origins with
 * scripts/publish-expansion-stamps.sh.
 */

/** Bust CDN `immutable` when the plates are redrawn. */
const STAMP_CACHE = 'st1';

/**
 * Per-printing stamps: the catalog card_number names the stamp
 * ("089/214 | Mewtwo Stamp", "109 | Pikachu 28", "Pawniard Stampad | 045/053").
 * A printing whose number names no stamp keeps the set's mark.
 */
export const PRINTING_STAMPS = {
  'battle-academy-2020': ['charizard', 'mewtwo', 'pikachu'],
  'battle-academy-2022': ['cinderace', 'eevee', 'pikachu'],
  'battle-academy-2024': ['armarouge', 'darkrai', 'pikachu'],
  'scarlet-and-violet-battle-academy': ['greninja', 'lucario', 'pikachu', 'sprigatito'],
  'beginning-set': ['oshawott', 'snivy', 'tepig'],
  'beginning-set-plus': ['oshawott', 'snivy', 'tepig'],
  'beginning-set-pikachu-version': ['oshawott', 'snivy', 'tepig'],
  'national-pokedex-beginning-set': ['oshawott', 'snivy', 'tepig'],
  'xy-beginning-set': ['chespin', 'fennekin'],
  'everyone-s-exciting-battle': [
    'cobalion', 'keldeo', 'meloetta', 'pikachu', 'terrakion', 'victini', 'virizion', 'zoroark',
  ],
  'emboar-ex-vs-togekiss-ex-deck-kit': ['emboar', 'togekiss'],
  'battle-gift-set-thundurus-vs-tornadus': ['thundurus', 'tornadus'],
  'mewtwo-vs-genesect-deck-kit': ['genesect', 'mewtwo'],
  'my-first-battle': ['bulbasaur', 'charmander', 'pikachu', 'poke-ball', 'squirtle'],
  'sword-and-shield-family-pokemon-card-game': ['pawniard', 'pikachu', 'tyranitar'],
  'holiday-calendar': ['holiday-snowflake'],
};

/** Half-deck Trainer Kits print the mascot as the set symbol on every card. */
export const SET_STAMPS = {
  'bw-trainer-kit-excadrill': 'excadrill',
  'bw-trainer-kit-zoroark': 'zoroark',
  'dp-trainer-kit-lucario': 'lucario',
  'dp-trainer-kit-manaphy': 'manaphy',
  'ex-trainer-kit-2-minun': 'minun',
  'ex-trainer-kit-2-plusle': 'plusle',
  'hs-trainer-kit-gyarados': 'gyarados',
  'hs-trainer-kit-raichu': 'raichu',
  'sun-and-moon-trainer-kit-lycanroc-and-alolan-raichu-alolan-raichu': 'alolan-raichu',
  'sun-and-moon-trainer-kit-lycanroc-and-alolan-raichu-lycanroc': 'lycanroc',
  // CardTrader files the 2004 EX Trainer Kit halves under these names.
  'xy-trainer-kit-latias': 'latias',
  'xy-trainer-kit-latios': 'latios',
  'xy-trainer-kit-bisharp': 'bisharp',
  'xy-trainer-kit-noivern': 'noivern',
  'xy-trainer-kit-pikachu-libre-and-suicune-pikachu-libre': 'pikachu-libre',
  'xy-trainer-kit-pikachu-libre-and-suicune-suicune': 'suicune',
  'xy-trainer-kit-sylveon': 'sylveon',
  'xy-trainer-kit-wigglytuff': 'wigglytuff',
};

/** Catalog spellings that differ from the stamp key (CardTrader typos included). */
const STAMP_PATTERNS = {
  darkrai: /\b(?:darkrai|drakai)\b/i,
  tyranitar: /\btyrann?itar\b/i,
  'poke-ball': /\bpok[eé]mon ball\b/i,
  'holiday-snowflake': /\bsnowflake\b/i,
};

function stampPattern(key) {
  return STAMP_PATTERNS[key] || new RegExp(`\\b${key}\\b`, 'i');
}

/** Every plate the catalog mapping can ask for. */
export const STAMP_KEYS = [...new Set([
  ...Object.values(PRINTING_STAMPS).flat(),
  ...Object.values(SET_STAMPS),
])].sort();

/**
 * Stamp key for an expansion `slug` and, on a printing, its `number`
 * (catalog card_number). Empty when the printing has no known stamp.
 */
export function expansionStampKey(row = {}, hostname) {
  if (!isPokemonGame(hostname)) return '';
  const slug = String(row.slug || '').trim();
  if (!slug) return '';
  const number = String(row.number ?? row.card_number ?? '');
  if (number) {
    for (const key of PRINTING_STAMPS[slug] || []) {
      if (stampPattern(key).test(number)) return key;
    }
  }
  return SET_STAMPS[slug] || '';
}

export function expansionStampSrc(row = {}, hostname) {
  const key = expansionStampKey(row, hostname);
  return key ? `/card-images/expansions/stamps/${key}.png?v=${STAMP_CACHE}` : '';
}
