'use strict';

const test = require('node:test');
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
