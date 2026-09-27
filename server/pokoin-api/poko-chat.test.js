'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanCards,
  cleanImages,
  cardsContext,
  imagesContext,
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
