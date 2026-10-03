'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler, tcgplayerProductUrl } = require('./tcgplayer-redirect');

const gameDeps = {
  parseGameFromRequest: () => 'pokemon',
  runWithGame: (_game, fn) => fn(),
  currentGame: () => 'pokemon',
};

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('product url is the TCGplayer product page', () => {
  assert.equal(tcgplayerProductUrl('198527'), 'https://www.tcgplayer.com/product/198527');
  assert.equal(tcgplayerProductUrl(''), '');
  assert.equal(tcgplayerProductUrl('abc'), '');
});

test('a linked card returns its TCGplayer product', async () => {
  const handler = createHandler({
    ...gameDeps,
    readTcgplayerProductId: async (game, cardId) => (game === 'pokemon' && cardId === '208878' ? '198527' : ''),
  });
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/tcgplayer-redirect?id=208878&format=json', headers: { host: 'pokoin.com' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://www.tcgplayer.com/product/198527');
  assert.equal(res.body.productId, '198527');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('an unlinked card is a 404 so the desk can search instead', async () => {
  const handler = createHandler({ ...gameDeps, readTcgplayerProductId: async () => '' });
  const res = mockRes();
  await handler({ method: 'GET', url: '/?id=999&format=json', headers: { host: 'pokoin.com' } }, res);
  assert.equal(res.statusCode, 404);
});
