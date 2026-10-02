'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { rewriteCdnPokoinPrefix } = require('./_marketplace_row');

function authWithToken(decoded) {
  const filename = path.join(__dirname, '_search_debug_auth.js');
  const sandbox = new Module(filename, module);
  sandbox.filename = filename;
  sandbox.paths = module.paths;
  sandbox.require = (request) => request === './_firebase'
    ? { verifyBearerToken: async () => decoded } : module.require(request);
  sandbox._compile(fs.readFileSync(filename, 'utf8'), filename);
  return sandbox.exports;
}

test('search overlay preserves verified operator email authorization', async () => {
  const token = { uid: 'operator', email: 'pokoinpos@gmail.com' };
  for (const email_verified of [undefined, false, 'true']) {
    await assert.rejects(authWithToken({ ...token, email_verified })
      .authorizeSearchDebugRequest({}), { statusCode: 403 });
  }
  assert.equal((await authWithToken({ ...token, email_verified: true })
    .authorizeSearchDebugRequest({})).uid, 'operator');
  await assert.rejects(authWithToken({ uid: 'other', email: 'other@example.test',
    email_verified: true, name: token.email }).authorizeSearchDebugRequest({}), { statusCode: 403 });
  assert.equal((await authWithToken({ uid: 'admin', admin: true })
    .authorizeSearchDebugRequest({})).uid, 'admin');
});

test('search overlay preserves raw CardTrader image keys for satellite games', () => {
  const row = { card_id: 246, ct_id: 123 };
  for (const game of ['palworld', 'cyberpunk', 'magic', 'weiss-schwarz', 'final-fantasy',
    'force-of-will', 'world-of-warcraft', 'battle-spirits-saga', 'star-wars-destiny',
    'dragon-born', 'my-little-pony', 'the-spoils']) {
    for (const suffix of ['123_card.jpg', 'previews/123_homepage.webp']) {
      const url = `https://cdn.pokoin.com/${game}/${suffix}`;
      assert.equal(rewriteCdnPokoinPrefix(url, row), url);
    }
  }
  assert.equal(rewriteCdnPokoinPrefix('https://cdn.pokoin.com/123_card.jpg', row),
    'https://cdn.pokoin.com/246_card.jpg');
});

test('search overlay keeps the maintained game registry and Cardmarket aliases', () => {
  const owned = require('./_cardtrader_game_ingest');
  const maintained = require('../pokoin-api/_cardtrader_game_ingest');
  assert.deepEqual(owned.INGEST_GAMES, maintained.INGEST_GAMES);
  for (const [alias, id] of [['fftcg', 'final_fantasy'], ['swd', 'star_wars_destiny'],
    ['ws', 'weiss_schwarz'], ['mlp', 'my_little_pony']]) {
    assert.equal(owned.normalizeIngestGame(alias), id);
    assert.equal(owned.INGEST_GAMES[id].cardtraderGameId, null);
  }
  const list = owned.ingestGameList();
  const firstCardmarket = list.findIndex((game) => game.cardtraderGameId == null);
  assert.ok(firstCardmarket > 0);
  assert.ok(list.slice(firstCardmarket).every((game) => game.cardtraderGameId == null));
});
