/** A desk response binds the public id and the requested catalog. */
import { GAMES, publicGamePath } from './game.js';

const CARD_DESK = /^\/marketplace\/[^/]+\/cards\/\d+(?:\/([^/?#]*)|$)/;

function slugWords(text) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Where a Pokémon desk 404 can go when its body names the catalogs holding the
 * id (pokoin-rust catalog_api.rs): `ownerGame` when exactly one does,
 * `ownerGames` (game, name, set) whenever any does. The 200000000+ Cardmarket
 * ids repeat across games, so several holders are told apart by the card name
 * in the URL slug; failing that, `choices` lists one desk link per game.
 * `location` is the same desk URL under the owner's slug, '' when there is none.
 */
export function ownerGameChoice(err, { gameId = 'pokemon', pathname = '', search = '', hash = '' } = {}) {
  const none = { location: '', choices: [] };
  const desk = String(pathname || '').match(CARD_DESK);
  if (err?.status !== 404 || gameId !== 'pokemon' || !desk) return none;
  const at = (owner) => {
    const next = publicGamePath(pathname, owner);
    return next && next !== pathname ? `${next}${search}${hash}` : '';
  };
  const owner = String(err?.body?.ownerGame || '');
  if (GAMES[owner]?.slug) return { location: at(owner), choices: [] };
  const holders = (Array.isArray(err?.body?.ownerGames) ? err.body.ownerGames : [])
    .filter((row) => GAMES[row?.game]?.slug);
  if (holders.length === 1) return { location: at(holders[0].game), choices: [] };
  const slug = `-${slugWords(desk[1])}-`;
  const named = slug.length > 2
    ? holders.filter((row) => slugWords(row.name) && slug.includes(`-${slugWords(row.name)}-`))
    : [];
  if (named.length === 1) return { location: at(named[0].game), choices: [] };
  return {
    location: '',
    choices: holders.map((row) => ({
      game: row.game,
      gameName: GAMES[row.game].name,
      name: String(row.name || ''),
      set: String(row.set || ''),
      href: at(row.game),
    })),
  };
}

/** The one game a game-less desk link moves to, '' when there is none (see ownerGameChoice). */
export function ownerGameLocation(err, options) {
  return ownerGameChoice(err, options).location;
}

export function cardPageMatchesId(cardId, data, { gameId = 'pokemon' } = {}) {
  const expected = String(cardId || '').trim();
  const actual = String(data?.card?.id || data?.card?.card_id || '').trim();
  if (!/^[1-9]\d*$/.test(expected) || actual !== expected) return false;
  if (data?.game && data.game !== gameId) return false;
  const prefix = GAMES[gameId]?.slug ? `/${GAMES[gameId].slug}` : '';
  // The API emits game-less paths (the desk adds the slug with publicGamePath),
  // so a satellite card may carry either form; another game's prefix is still
  // rejected. Same rule as pokoin-rust apps/api/src/card_identity.rs.
  return [data?.canonicalPath, data?.card?.canonicalPath, data?.card?.canonical_path]
    .filter(Boolean).every((path) => {
      const match = String(path).match(/^(.*?)\/marketplace\/[^/]+\/cards\/(\d+)(?:\/|$)/);
      return Boolean(match) && (match[1] === '' || match[1] === prefix) && match[2] === expected;
    });
}

export function assertCardPageIdentity(cardId, data, options) {
  if (!cardPageMatchesId(cardId, data, options)) {
    const error = new Error('The card response did not match the requested card.');
    error.code = 'card_identity_mismatch';
    throw error;
  }
  return data;
}
