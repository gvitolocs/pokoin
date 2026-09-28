'use strict';

const test = require('node:test');
const Module = require('node:module');
const TARGET = require('node:path').resolve(__dirname, 'poko-chat.js');
const assert = require('node:assert/strict');
const {
  cleanCards,
  cleanImages,
  cleanPageContext,
  cardsContext,
  imagesContext,
  marketFirstDirective,
  resolveHermesChatUrl,
  hermesToken,
} = require('./poko-chat')._test;

test('cleanCards keeps id/name and caps at 8', () => {
  const rows = cleanCards([
    { cardId: '123', name: 'Pikachu', setName: 'Base' },
    { id: '456', cardName: 'Raichu' },
    ...Array.from({ length: 10 }, (_, i) => ({ cardId: String(i), name: `C${i}` })),
  ]);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].name, 'Pikachu');
  assert.equal(rows[1].name, 'Raichu');
});

test('cleanImages keeps http(s) urls only', () => {
  assert.deepEqual(
    cleanImages(['https://cdn.pokoin.com/a.jpg', 'ftp://x', 'not']),
    ['https://cdn.pokoin.com/a.jpg'],
  );
});

test('cardsContext and imagesContext', () => {
  assert.match(cardsContext([{ cardId: '1', name: 'Mew' }]), /Attached cards/);
  assert.match(imagesContext(['https://cdn.pokoin.com/a.jpg']), /Attached photos/);
});

test('marketFirstDirective and cleanPageContext pin desk cardId', () => {
  const cards = cleanCards([{ cardId: '246912', name: 'Noivern V', setName: 'Evolving Skies' }]);
  const ctx = cleanPageContext({ path: '/marketplace/en/cards/246912' }, cards, []);
  assert.equal(ctx.deskCardId, '246912');
  assert.equal(ctx.deskCardName, 'Noivern V');
  const directive = marketFirstDirective(cards, ctx);
  assert.match(directive, /card_quote/);
  assert.match(directive, /card_ocr/);
  assert.match(directive, /246912/);
  assert.match(directive, /Never invent/);
  assert.equal(marketFirstDirective([], {}), '');
});

test('resolveHermesChatUrl matches pokoin-assistant convention', () => {
  assert.equal(resolveHermesChatUrl({}), '');
  assert.equal(
    resolveHermesChatUrl({ POKONTACT_SERVICE_URL: 'http://92.5.153.117:8789/api/poko' }),
    'http://92.5.153.117:8789/api/poko/chat',
  );
  assert.equal(
    resolveHermesChatUrl({ POKO_CHAT_URL: 'http://host/api/poko/chat' }),
    'http://host/api/poko/chat',
  );
  assert.equal(
    resolveHermesChatUrl({ POKO_CHAT_URL: 'http://host/api/poko/' }),
    'http://host/api/poko/chat',
  );
});

test('hermesToken prefers POKO_API_TOKEN then POKONTACT', () => {
  assert.equal(hermesToken({ POKO_API_TOKEN: 'a', POKONTACT_SERVICE_TOKEN: 'b' }), 'a');
  assert.equal(hermesToken({ POKONTACT_SERVICE_TOKEN: 'b' }), 'b');
});

test('hammering the endpoint from one IP hits the 20/min rate limit', async () => {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  process.env.POKONTACT_SERVICE_TOKEN = 'svc';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, reply: 'Pong ✨' }),
  });
  Module._load = function load(request, parent, isMain) {
    if (request === './_firebase' || String(request).endsWith('_firebase') || String(request).includes('/_firebase')) {
      return {
        verifyBearerToken: async () => ({ uid: 'fb-1', email: '', name: '' }),
        getFirebaseAdmin: () => ({
          firestore: Object.assign(() => ({
            collection: () => ({
              doc: () => ({
                collection: () => ({ doc: () => ({ id: `evt-${Math.random().toString(16).slice(2)}` }) }),
                set: async () => {},
              }),
            }),
            batch: () => ({
              set() { return this; },
              async commit() {},
            }),
          }), {
            FieldValue: { serverTimestamp: () => new Date() },
          }),
        }),
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[TARGET];
  try {
    const handler = require(TARGET);
    let saw429 = false;
    for (let i = 0; i < 25; i += 1) {
      const res = {
        statusCode: 0,
        headersSent: false,
        setHeader() { return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await handler({
        method: 'POST',
        headers: { authorization: 'Bearer fb-token', 'x-forwarded-for': '203.0.113.7' },
        body: { message: `msg ${i}` },
      }, res);
      if (res.statusCode === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, 'expected a 429 within 25 rapid messages');
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});
