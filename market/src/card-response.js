/** A desk response binds the public id and the requested catalog. */
import { GAMES } from './game.js';

export function cardPageMatchesId(cardId, data, { gameId = 'pokemon' } = {}) {
  const expected = String(cardId || '').trim();
  const actual = String(data?.card?.id || data?.card?.card_id || '').trim();
  if (!/^[1-9]\d*$/.test(expected) || actual !== expected) return false;
  if (data?.game && data.game !== gameId) return false;
  const prefix = GAMES[gameId]?.slug ? `/${GAMES[gameId].slug}` : '';
  return [data?.canonicalPath, data?.card?.canonicalPath, data?.card?.canonical_path]
    .filter(Boolean).every((path) => {
      const match = String(path).match(/^(.*?)\/marketplace\/[^/]+\/cards\/(\d+)(?:\/|$)/);
      return match?.[1] === prefix && match?.[2] === expected;
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
