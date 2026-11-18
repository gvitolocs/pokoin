import { CARD_STAMPS } from './data/card-stamps.js';
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
const STAMP_CACHE = 'st2';

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
  'xy-beginning-set': ['chespin', 'fennekin', 'froakie'],
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

/**
 * Every card of these products carries the same stamp: half-deck Trainer Kits
 * print the mascot as the set symbol, the Victini theme deck a Victini, Trick
 * or Trade the Pumpkaboo, Prize Packs the Play! Pokémon mark (checked on scans).
 */
export const SET_STAMPS = {
  'battle-theme-deck-victini': 'victini',
  'trick-or-trade': 'pumpkaboo',
  'trick-or-trade-2023': 'pumpkaboo',
  'trick-or-trade-2024': 'pumpkaboo',
  'play-pokemon-prize-pack-series': 'play-pokemon',
  'play-pokemon-prize-pack-series-one': 'play-pokemon',
  'play-pokemon-prize-pack-series-two': 'play-pokemon',
  'play-pokemon-prize-pack-series-three': 'play-pokemon',
  'play-pokemon-prize-pack-series-four': 'play-pokemon',
  'play-pokemon-prize-pack-series-five': 'play-pokemon',
  'play-pokemon-prize-pack-series-six': 'play-pokemon',
  'play-pokemon-prize-pack-series-seven': 'play-pokemon',
  'play-pokemon-prize-pack-series-eight': 'play-pokemon',
  'play-pokemon-prize-pack-series-nine': 'play-pokemon',
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
  ...Object.values(CARD_STAMPS),
])].sort();

/**
 * Stamp key for an expansion `slug` and, on a printing, its `number`
 * (catalog card_number) and `id` (card_id, for stamps read off the scan).
 * Empty when the printing has no known stamp.
 */
export function expansionStampKey(row = {}, hostname) {
  if (!isPokemonGame(hostname)) return '';
  const fromScan = CARD_STAMPS[String(row.id ?? row.card_id ?? '').trim()];
  if (fromScan) return fromScan;
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
