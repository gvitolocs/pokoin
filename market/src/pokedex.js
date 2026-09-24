import SPECIES from './data/pokedex-species.js';
import { tagTeamPartners } from './tag-team-partners.js';

/** Sort key for trainer / energy / item cards with no National Dex match. */
export const TRAINER_DEX = 10000;

function compactToken(part) {
  return String(part || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function pokedexTokens(name) {
  // Fold accents before splitting: otherwise é is a separator and Flabébé never reaches flabebe.
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/♀/g, ' f ')
    .replace(/♂/g, ' m ')
    .split(/[^a-zA-Z0-9]+/)
    .map(compactToken)
    .filter(Boolean);
}

/** TCG fossil items (Old Amber Aerodactyl, Dome Fossil Kabuto, …) are trainers. */
const FOSSIL_TRAINER = /^(?:antique\s+)?(?:old(?:\s+old)?\s+amber|(?:mysterious|unidentified|rare|buried|holon)\s+fossil|fossil\s+egg|(?:dome|helix|root|claw|skull|armor|cover|plume|jaw|sail)\s+fossil)\b/i;

/** Item / Tool printings that append a Pokémon name (Mewtwo Spirit Link). */
const ITEM_TRAINER_SUFFIX = /\bspirit link$/i;

/** Clefairy Doll / Snorlax Doll / Poké Doll — items, not the species. */
const DOLL_ITEM = /\b(?:pok[ée]?\s*)?doll$/i;

/** Rotom Phone / Dex / Catalog / Bike are items. Heat Rotom / Rotom V stay #479. */
const ROTOM_ITEM = /\brotom\s+(?:phone|dex|catalog|bike)\b/i;

export function isFossilTrainerName(name) {
  return FOSSIL_TRAINER.test(String(name || '').replace(/\s+/g, ' ').trim());
}

export function isRotomItemName(name) {
  return ROTOM_ITEM.test(String(name || '').replace(/\s+/g, ' ').trim());
}

export function isDollTrainerName(name) {
  return DOLL_ITEM.test(String(name || '').replace(/\s+/g, ' ').trim());
}

export function isTrainerItemName(name) {
  const text = String(name || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return isFossilTrainerName(text)
    || ITEM_TRAINER_SUFFIX.test(text)
    || isRotomItemName(text)
    || isDollTrainerName(text);
}

/** First National Dex hit in a name fragment. 0 if none. */
function firstSpeciesNumber(name) {
  const tokens = pokedexTokens(name);
  let best = null;
  for (let i = 0; i < tokens.length; i += 1) {
    for (let span = 3; span >= 1; span -= 1) {
      if (i + span > tokens.length) continue;
      const key = tokens.slice(i, i + span).join('');
      if (key.length < 3) continue;
      const n = SPECIES[key];
      if (!n) continue;
      if (!best || i < best.pos || (i === best.pos && span > best.span)) {
        best = { n, pos: i, span };
      }
    }
  }
  return best ? best.n : 0;
}

function cardName(cardOrName) {
  return typeof cardOrName === 'string'
    ? cardOrName
    : (cardOrName?.name || cardOrName?.english_name || '');
}

/**
 * Tag Team GX uses the hand list (once per partner). Everything else is one Dex.
 */
export function pokedexPartnerNumbers(cardOrName) {
  const name = cardName(cardOrName);
  if (isTrainerItemName(name)) {
    return [];
  }
  const tagged = tagTeamPartners(name);
  if (tagged?.length) {
    return [...new Set(tagged)];
  }
  const n = firstSpeciesNumber(name);
  return n > 0 ? [n] : [];
}

/** Lowest partner Dex (species hubs, SEO). 0 if not a Pokémon. */
export function pokedexNumber(cardOrName) {
  const nums = pokedexPartnerNumbers(cardOrName);
  return nums.length ? Math.min(...nums) : 0;
}

export function pokedexSortValue(card) {
  const slot = Number(card?.pokedexSlot);
  if (slot > 0) return slot;
  return pokedexNumber(card) || TRAINER_DEX;
}
