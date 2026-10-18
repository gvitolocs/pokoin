import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCardPageIdentity, cardPageMatchesId, ownerGameChoice, ownerGameLocation } from './card-response.js';

test('a game-less link to another TCG moves under that game', () => {
  const err = { status: 404, body: { error: 'Card not found.', cardId: '834950', ownerGame: 'digimon' } };
  const at = { pathname: '/marketplace/en/cards/834950/sr-omnimon', search: '?q=1', hash: '#shop' };
  assert.equal(ownerGameLocation(err, at), '/digimon/marketplace/en/cards/834950/sr-omnimon?q=1#shop');
  assert.equal(
    ownerGameLocation({ ...err, body: { ownerGame: 'dragon_ball_super' } }, at),
    '/dragon-ball-super/marketplace/en/cards/834950/sr-omnimon?q=1#shop',
  );
  // Plain 404s, unknown games, satellite desks and non-desk paths stay put.
  assert.equal(ownerGameLocation({ status: 404, body: {} }, at), '');
  assert.equal(ownerGameLocation({ status: 404, body: { ownerGame: 'chess' } }, at), '');
  assert.equal(ownerGameLocation({ status: 503, body: { ownerGame: 'digimon' } }, at), '');
  assert.equal(ownerGameLocation(err, { ...at, gameId: 'digimon' }), '');
  assert.equal(ownerGameLocation(err, { pathname: '/marketplace/search' }), '');
});

test('a shared Cardmarket id finds its game by the URL slug, or offers each game', () => {
  // 200000874 is Arcana Joker in Battle Spirits Saga and a different card in six
  // other Cardmarket-only games, so ownerGame is absent and ownerGames lists them.
  const err = { status: 404, body: { error: 'Card not found.', cardId: '200000874', ownerGames: [
    { game: 'final_fantasy', name: 'President Shinra', set: 'Opus XXI' },
    { game: 'world_of_warcraft', name: "No'Kaled, the Elements of Death", set: 'Cataclysm' },
    { game: 'battle_spirits_saga', name: 'Arcana Joker', set: 'False Gods' },
    { game: 'chess', name: 'Rook', set: '' },
  ] } };
  const slugged = { pathname: '/marketplace/en/cards/200000874/uc-arcana-joker-bss02-065-false-gods', search: '', hash: '#shop' };
  assert.deepEqual(ownerGameChoice(err, slugged), {
    location: '/battle-spirits-saga/marketplace/en/cards/200000874/uc-arcana-joker-bss02-065-false-gods#shop',
    choices: [],
  });
  assert.equal(
    ownerGameLocation(err, { pathname: '/marketplace/en/cards/200000874/no-kaled-the-elements-of-death' }),
    '/world-of-warcraft/marketplace/en/cards/200000874/no-kaled-the-elements-of-death',
  );
  // No slug (MyPokoin's old links): one link per known game, nothing guessed.
  const bare = ownerGameChoice(err, { pathname: '/marketplace/en/cards/200000874' });
  assert.equal(bare.location, '');
  assert.deepEqual(bare.choices.map((row) => [row.gameName, row.name, row.href]), [
    ['Final Fantasy TCG', 'President Shinra', '/final-fantasy/marketplace/en/cards/200000874'],
    ['World of Warcraft TCG', "No'Kaled, the Elements of Death", '/world-of-warcraft/marketplace/en/cards/200000874'],
    ['Battle Spirits Saga', 'Arcana Joker', '/battle-spirits-saga/marketplace/en/cards/200000874'],
  ]);
  // One known holder moves at once; satellite desks and other pages never choose.
  assert.equal(
    ownerGameLocation({ status: 404, body: { ownerGames: [{ game: 'digimon', name: 'Omnimon' }] } }, { pathname: '/marketplace/en/cards/834950' }),
    '/digimon/marketplace/en/cards/834950',
  );
  assert.deepEqual(ownerGameChoice(err, { ...slugged, gameId: 'magic' }), { location: '', choices: [] });
  assert.deepEqual(ownerGameChoice(err, { pathname: '/marketplace/en/cards/200000874abc' }), { location: '', choices: [] });
});

test('public Pokoin id binds the desk and every canonical link', () => {
  const expected = '806342';
  assert.equal(cardPageMatchesId(expected, { card: { id: expected } }), true);
  for (const data of [
    { card: { id: '511164' } },
    { card: { id: '403171' } },
    { card: { id: expected, canonicalPath: '/marketplace/en/cards/511164/other' } },
    { card: { id: expected }, canonicalPath: '/marketplace/en/cards/403171/blueprint' },
  ]) assert.throws(() => assertCardPageIdentity(expected, data), { code: 'card_identity_mismatch' });
});

test('same numeric id in another game cannot change the catalog', () => {
  const data = { game: 'lorcana', card: { id: '806390', canonicalPath: '/lorcana/marketplace/en/cards/806390/megara' } };
  assert.equal(cardPageMatchesId('806390', data), false);
  assert.equal(cardPageMatchesId('806390', data, { gameId: 'lorcana' }), true);
});

test('a satellite desk accepts the game-less canonical path the API emits', () => {
  // Live digimon payload: canonicalPath has no /digimon prefix.
  const path = '/marketplace/en/cards/834950/sr-omnimon-ex12-037-pb-27-premium-battle-set-royal-knights';
  const data = { game: 'digimon', card: { id: '834950', canonicalPath: path, canonical_path: path }, canonicalPath: path };
  assert.equal(cardPageMatchesId('834950', data, { gameId: 'digimon' }), true);
  assert.equal(cardPageMatchesId('834950', { ...data, game: undefined }, { gameId: 'weiss_schwarz' }), true);
  // Another game's payload or prefix is still refused.
  assert.equal(cardPageMatchesId('834950', data, { gameId: 'yugioh' }), false);
  const other = { card: { id: '834950', canonicalPath: '/one-piece/marketplace/en/cards/834950/x' } };
  assert.equal(cardPageMatchesId('834950', other, { gameId: 'digimon' }), false);
  assert.equal(cardPageMatchesId('834950', other), false);
});
