/**
 * Listing “faces” (finish / extras) differ by TCG.
 * CardTrader exposes game-prefixed foils (riftbound_foil, mtg_foil, …);
 * Pokémon keeps Standard / Holo / Reverse.
 */

import { gameIdFromHost } from './game.js';

const POKEMON_FOILS = [
  { value: 'standard', label: 'Standard' },
  { value: 'holo', label: 'Holo' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'stamped', label: 'Stamped' },
  { value: 'promo', label: 'Promo' },
  { value: 'other', label: 'Other' },
];

/** Binary foil games (Riftbound, Magic, Lorcana, …). */
const BINARY_FOILS = [
  { value: 'standard', label: 'Non-foil' },
  { value: 'foil', label: 'Foil' },
];

const BINARY_FOIL_GAMES = new Set([
  'riftbound',
  'magic',
  'lorcana',
  'flesh_and_blood',
  'digimon',
  'dragon_ball_super',
  'vanguard',
  'star_wars',
  'union_arena',
  'gundam',
  'sorcery',
  'palworld',
  'cyberpunk',
  'one_piece',
]);

export function listingFoilOptions(gameId = gameIdFromHost()) {
  const id = String(gameId || 'pokemon');
  if (BINARY_FOIL_GAMES.has(id)) return BINARY_FOILS;
  return POKEMON_FOILS;
}

/** Extra chips on the List form — 1st Ed. is Pokémon-only. */
export function listingExtraChips(gameId = gameIdFromHost()) {
  const shared = [
    { key: 'sealed', label: 'Sealed' },
    { key: 'graded', label: 'Graded' },
    { key: 'shipping', label: 'Shipping' },
  ];
  if (String(gameId || 'pokemon') === 'pokemon') {
    return [{ key: 'firstEd', label: '1st Ed.' }, ...shared];
  }
  return shared;
}

/** Map a CT properties bag (or listing) onto Pokoin foil_state. */
export function foilStateFromProperties(properties = {}) {
  const props = properties && typeof properties === 'object' ? properties : {};
  if (String(props.pokemon_reverse || '').toLowerCase() === 'true') return 'reverse';
  const explicit = String(props.foil_state || props.foilState || '').toLowerCase();
  if (explicit === 'reverse' || explicit === 'holo' || explicit === 'foil'
    || explicit === 'stamped' || explicit === 'promo' || explicit === 'other'
    || explicit === 'standard') {
    return explicit === 'regular' ? 'standard' : explicit;
  }
  for (const [key, value] of Object.entries(props)) {
    const name = String(key || '').toLowerCase();
    if (name !== 'foil' && name !== 'mtg_foil' && !name.endsWith('_foil')) continue;
    const on = value === true || ['true', 'yes', '1', 'foil'].includes(String(value).toLowerCase());
    if (on) return 'foil';
  }
  return 'standard';
}
