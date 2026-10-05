// Games on Pokoin News. URL slugs come from the article contract
// (schema.mjs GAME_SLUGS, mirroring market/src/game.js): Pokémon news lives at
// /news, every other game at /<slug>/news. Editorial pages stay under /news.
import { GAME_SLUGS, gameNewsBase } from './schema.mjs';

export const GAME_NAMES = Object.freeze({
  pokemon: 'Pokémon', one_piece: 'One Piece', riftbound: 'Riftbound', magic: 'Magic: The Gathering', yugioh: 'Yu-Gi-Oh!',
  lorcana: 'Lorcana', flesh_and_blood: 'Flesh and Blood', digimon: 'Digimon', dragon_ball_super: 'Dragon Ball Super',
  vanguard: 'Vanguard', star_wars: 'Star Wars: Unlimited', union_arena: 'Union Arena', gundam: 'Gundam', sorcery: 'Sorcery',
  palworld: 'Palworld', cyberpunk: 'Cyberpunk', weiss_schwarz: 'Weiss Schwarz', final_fantasy: 'Final Fantasy TCG',
  force_of_will: 'Force of Will', world_of_warcraft: 'World of Warcraft TCG', battle_spirits_saga: 'Battle Spirits Saga',
  star_wars_destiny: 'Star Wars Destiny', the_spoils: 'The Spoils', my_little_pony: 'My Little Pony CCG', dragon_born: 'Dragoborne',
});

// Always shown in the switcher, in this order; other games appear once they have stories.
const PINNED = ['pokemon', 'one_piece', 'magic', 'yugioh', 'lorcana', 'riftbound'];

export function gameOf(record) {
  return (record && GAME_SLUGS[record.game] !== undefined) ? record.game : 'pokemon';
}

export function gameName(game) {
  return GAME_NAMES[game] || GAME_NAMES.pokemon;
}

export function gameMarketplaceBase(game) {
  const slug = GAME_SLUGS[game] || '';
  return slug ? `/${slug}/marketplace` : '/marketplace';
}

export function sectionHref(game, section) {
  return `${gameNewsBase(game)}/${section}`;
}

/** Games that have at least one published story, Pokémon always first. */
export function gamesWithNews(records) {
  const counts = new Map();
  for (const record of records || []) {
    if (!record || record.status !== 'published') continue;
    counts.set(gameOf(record), (counts.get(gameOf(record)) || 0) + 1);
  }
  const games = ['pokemon', ...[...counts.keys()].filter((game) => game !== 'pokemon').sort((a, b) => counts.get(b) - counts.get(a))];
  return games;
}

/** Switcher entries: pinned games, then any other game with stories. */
export function gameSwitcher(records) {
  const withNews = gamesWithNews(records);
  const ids = [...PINNED, ...withNews.filter((game) => !PINNED.includes(game))];
  return ids.map((id) => ({ id, name: id === 'magic' ? 'Magic' : gameName(id), href: gameNewsBase(id) }));
}

export { gameNewsBase };
