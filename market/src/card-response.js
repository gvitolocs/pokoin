/** A desk response binds the public id and the requested catalog. */
import { GAMES, publicGamePath } from './game.js';

/**
 * A Pokémon desk 404 whose body names the catalog that holds the id
 * (`ownerGame`, pokoin-rust catalog_api.rs): the same desk URL under that
 * game's slug, for game-less links to another TCG. '' when there is none.
 */
export function ownerGameLocation(err, { gameId = 'pokemon', pathname = '', search = '', hash = '' } = {}) {
  const owner = err?.status === 404 ? String(err?.body?.ownerGame || '') : '';
  if (gameId !== 'pokemon' || !GAMES[owner]?.slug) return '';
  if (!/^\/marketplace\/[^/]+\/cards\/\d+(?:\/|$)/.test(pathname)) return '';
  const next = publicGamePath(pathname, owner);
  return next && next !== pathname ? `${next}${search}${hash}` : '';
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
