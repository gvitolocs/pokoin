'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'marketplace-recents.js');

function loadHandler(stubs) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: stubs.marketplaceQuery,
        marketplaceWriteQuery: stubs.marketplaceWriteQuery || stubs.marketplaceQuery,
      };
    }
    if (request === './_firebase') {
      return {
        verifyBearerToken: stubs.verifyBearerToken,
        authErrorResponse: (error) => ({
          statusCode: error.statusCode || 401,
          body: { error: error.message },
        }),
      };
    }
    if (request === './_marketplace_game') {
      return {
        GAMES: {
          pokemon: { id: 'pokemon' },
          one_piece: { id: 'one_piece' },
          riftbound: { id: 'riftbound' },
        },
        runWithGame: async (_game, fn) => fn(),
      };
    }
    if (request === './_marketplace_react_card') {
      return {
        parsePublicCardId: (value) => {
          const text = String(value || '').trim();
          return /^\d+$/.test(text) && Number(text) > 0 ? text : '';
        },
        setCorsHeaders: (res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

function catalogStub(catalogByGame) {
  return async (sql, values) => {
    if (/marketplace_search_candidates/i.test(sql)) {
      const game = stubsGame.current || 'pokemon';
      const allowed = new Set(catalogByGame[game] || []);
      const wanted = (values[0] || []).map(String);
      return {
        rows: wanted.filter((id) => allowed.has(id)).map((id) => ({ id })),
      };
    }
    if (/marketplace_user_recents/i.test(sql) && /select card_ids/i.test(sql)) {
      const key = `${values[0]}:${values[1]}`;
      const cardIds = stubsGame.store.get(key) || [];
      return { rows: cardIds.length ? [{ card_ids: cardIds }] : [] };
    }
    return { rows: [] };
  };
}

const stubsGame = { store: new Map(), current: 'pokemon' };

test('knownMarketplaceGame accepts canonical games and rejects junk', () => {
  const { knownMarketplaceGame } = loadHandler({
    verifyBearerToken: async () => ({ uid: 'u' }),
    marketplaceQuery: async () => ({ rows: [] }),
  })._test;
  assert.equal(knownMarketplaceGame('pokemon'), 'pokemon');
  assert.equal(knownMarketplaceGame('riftbound'), 'riftbound');
  assert.equal(knownMarketplaceGame('one-piece'), 'one_piece');
  assert.equal(knownMarketplaceGame('not-a-game'), null);
  assert.equal(knownMarketplaceGame(''), null);
});

test('missing game is 400 — no silent pokemon default', async () => {
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async () => ({ rows: [] }),
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'api.pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error || ''), /Missing game/i);
});

test('invalid game is 400', async () => {
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async () => ({ rows: [] }),
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents?game=not-a-game',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 400);
});

test('satellite host supplies explicit game without query', async () => {
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async (sql, values) => {
      if (/marketplace_user_recents/i.test(sql)) {
        assert.equal(values[1], 'riftbound');
        return { rows: [{ card_ids: ['723286'] }] };
      }
      return { rows: [] };
    },
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'riftbound.pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.game, 'riftbound');
  assert.deepEqual(res.body.cardIds, ['723286']);
});

test('GET scopes by user and game at SQL boundary', async () => {
  const calls = [];
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-a' }),
    marketplaceQuery: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ card_ids: ['504094'] }] };
    },
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents?game=pokemon',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].values[0], 'user-a');
  assert.equal(calls[0].values[1], 'pokemon');
  assert.match(calls[0].sql, /and game = \$2/i);
  assert.notEqual(calls[0].values[0], 'user-b');
});

test('POST pokemon card does not appear in riftbound GET; PUT isolation holds', async () => {
  const store = new Map();
  const catalog = {
    pokemon: ['504094', '111'],
    riftbound: ['723286'],
  };
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async (sql, values) => {
      if (/marketplace_search_candidates/i.test(sql)) {
        // runWithGame stub does not pass game; infer from requested ids
        const wanted = (values[0] || []).map(String);
        const rows = [];
        for (const [game, ids] of Object.entries(catalog)) {
          for (const id of wanted) {
            if (ids.includes(id)) rows.push({ id });
          }
        }
        return { rows };
      }
      if (/select card_ids/i.test(sql)) {
        const key = `${values[0]}:${values[1]}`;
        const cardIds = store.get(key) || [];
        return { rows: cardIds.length ? [{ card_ids: cardIds }] : [] };
      }
      return { rows: [] };
    },
    marketplaceWriteQuery: async (_sql, values) => {
      store.set(`${values[0]}:${values[1]}`, values[2]);
      return { rows: [] };
    },
  });

  const postPokemon = mockRes();
  await handler({
    method: 'POST',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
    body: { game: 'pokemon', cardId: '504094' },
  }, postPokemon);
  assert.equal(postPokemon.statusCode, 200);
  assert.deepEqual(postPokemon.body.cardIds, ['504094']);

  const getRb = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents?game=riftbound',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
  }, getRb);
  assert.deepEqual(getRb.body.cardIds, []);

  const postRb = mockRes();
  await handler({
    method: 'POST',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
    body: { game: 'riftbound', cardId: '723286' },
  }, postRb);
  assert.deepEqual(postRb.body.cardIds, ['723286']);

  const getPk = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents?game=pokemon',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
  }, getPk);
  assert.deepEqual(getPk.body.cardIds, ['504094']);
});

test('POST card that is not in the game catalog is rejected', async () => {
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async (sql) => {
      if (/marketplace_search_candidates/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });
  const res = mockRes();
  await handler({
    method: 'POST',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
    body: { game: 'riftbound', cardId: '504094' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.code || ''), /INVALID_CARD/);
});

test('second POST of same card refreshes recency without duplicates', async () => {
  const store = new Map([['user-1:pokemon', ['111', '222']]]);
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async (sql, values) => {
      if (/marketplace_search_candidates/i.test(sql)) {
        return { rows: (values[0] || []).map((id) => ({ id: String(id) })) };
      }
      const cardIds = store.get(`${values[0]}:${values[1]}`) || [];
      return { rows: [{ card_ids: cardIds }] };
    },
    marketplaceWriteQuery: async (_sql, values) => {
      store.set(`${values[0]}:${values[1]}`, values[2]);
      return { rows: [] };
    },
  });
  const res = mockRes();
  await handler({
    method: 'POST',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
    body: { game: 'pokemon', cardId: '222' },
  }, res);
  assert.deepEqual(res.body.cardIds, ['222', '111']);
});

test('history limit and newest-first ordering on POST', async () => {
  const existing = Array.from({ length: 24 }, (_, i) => String(1000 + i));
  const store = new Map([['user-1:one_piece', existing]]);
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async (sql, values) => {
      if (/marketplace_search_candidates/i.test(sql)) {
        return { rows: (values[0] || []).map((id) => ({ id: String(id) })) };
      }
      return { rows: [{ card_ids: store.get(`${values[0]}:${values[1]}`) || [] }] };
    },
    marketplaceWriteQuery: async (_sql, values) => {
      store.set(`${values[0]}:${values[1]}`, values[2]);
      return { rows: [] };
    },
  });
  const res = mockRes();
  await handler({
    method: 'POST',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
    body: { game: 'one_piece', cardId: '999999' },
  }, res);
  assert.equal(res.body.cardIds.length, 24);
  assert.equal(res.body.cardIds[0], '999999');
  assert.ok(!res.body.cardIds.includes('1023'));
});

test('pre-migration unscoped schema returns empty — does not leak mixed ids', async () => {
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async () => {
      const error = new Error('column "game" does not exist');
      error.code = '42703';
      throw error;
    },
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents?game=pokemon',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.cardIds, []);
});

test('malformed bearer is 401 not 500', async () => {
  const handler = loadHandler({
    verifyBearerToken: async () => {
      const error = new Error('Decoding Firebase ID token failed.');
      error.code = 'auth/argument-error';
      throw error;
    },
    marketplaceQuery: async () => ({ rows: [] }),
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/marketplace-recents',
    headers: { authorization: 'Bearer invalid', host: 'pokoin.com' },
  }, res);
  assert.equal(res.statusCode, 401);
});

test('PUT replaces one game list only and validates catalog', async () => {
  const writes = [];
  const handler = loadHandler({
    verifyBearerToken: async () => ({ uid: 'user-1' }),
    marketplaceQuery: async (sql, values) => {
      if (/marketplace_search_candidates/i.test(sql)) {
        return { rows: (values[0] || []).map((id) => ({ id: String(id) })) };
      }
      return { rows: [] };
    },
    marketplaceWriteQuery: async (sql, values) => {
      writes.push({ sql, values });
      return { rows: [] };
    },
  });
  const res = mockRes();
  await handler({
    method: 'PUT',
    url: '/api/marketplace-recents?game=one_piece',
    headers: { authorization: 'Bearer t', host: 'pokoin.com' },
    body: { game: 'one_piece', cardIds: ['790994', '504094'] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.game, 'one_piece');
  assert.deepEqual(res.body.cardIds, ['790994', '504094']);
  assert.equal(writes[0].values[1], 'one_piece');
  assert.match(writes[0].sql, /on conflict \(user_uid, game\)/i);
});
