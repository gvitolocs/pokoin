'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanCards,
  cleanImages,
  cardsContext,
  imagesContext,
  looksLikeMarket,
  formatQuote,
} = require('./poko-chat')._test;

test('cleanCards keeps id/name and caps at 8', () => {
  const rows = cleanCards([
    { cardId: '123', name: 'Pikachu', setName: 'Base' },
    { id: '456', cardName: 'Raichu' },
    ...Array.from({ length: 10 }, (_, i) => ({ cardId: String(i), name: `C${i}` })),
  ]);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].cardId, '123');
  assert.equal(rows[0].name, 'Pikachu');
  assert.equal(rows[1].name, 'Raichu');
});

test('cleanImages keeps http(s) urls only', () => {
  assert.deepEqual(
    cleanImages(['https://cdn.pokoin.com/a.jpg', 'ftp://x', 'not']),
    ['https://cdn.pokoin.com/a.jpg'],
  );
});

test('cardsContext, imagesContext and market heuristics', () => {
  assert.match(cardsContext([{ cardId: '1', name: 'Mew' }]), /Attached cards/);
  assert.match(imagesContext(['https://cdn.pokoin.com/a.jpg']), /Attached photos/);
  assert.equal(looksLikeMarket('how much is this worth?'), true);
  assert.equal(looksLikeMarket('hello there'), false);
});

test('formatQuote summarizes sold and ask bands', () => {
  const text = formatQuote({
    status: 'ok',
    name: 'Mew ex',
    setName: '151',
    sold: { medianPkn: 400 },
    asks: { minPkn: 380 },
    confidence: 'medium',
  });
  assert.match(text, /Mew ex/);
  assert.match(text, /400 PKN/);
  assert.match(text, /380 PKN/);
});
