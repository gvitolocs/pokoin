'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseRange} = require('./marketplace-tcgplayer-history');
test('history rejects invalid dates and unbounded/injected identities',() => {
  for (const query of ['cardId=42&from=2024-02-30','cardId=42&from=2026-09-01&to=2024-01-01',
    'cardId=42%3Bdrop+table','cardId=42&from=2024-01-01&to=2040-01-01']) {
    assert.throws(() => parseRange(new URLSearchParams(query)),{statusCode:400});
  }
  assert.deepEqual(parseRange(new URLSearchParams('cardId=42&from=2024-02-08&to=2026-09-30')),
    {cardId:'42',from:'2024-02-08',to:'2026-09-30'});
});
