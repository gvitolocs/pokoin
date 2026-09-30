import assert from 'node:assert/strict';
import test from 'node:test';
import { parseItems, pickMatchedCt } from './marketplace-price-check.js';

test('price check parses cardId[:COND:LANG] items with a cap', () => {
  const items = parseItems('633380:NM:IT, 713648 , bad:, x:SP');
  assert.deepEqual(items, [
    { cardId: '633380', condition: 'NM', language: 'IT' },
    { cardId: '713648', condition: '', language: '' },
  ]);
  const many = parseItems(Array.from({ length: 150 }, (_, i) => `${i + 1}`).join(','));
  assert.equal(many.length, 100);
  assert.deepEqual(parseItems(''), []);
});

test('price check picks the matched CardTrader group, else the overall low', () => {
  const groups = [
    { condition: 'NM', language: 'EN', minPkn: 210 },
    { condition: 'NM', language: 'IT', minPkn: 180 },
    { condition: 'SP', language: 'EN', minPkn: 150 },
    { condition: 'MP', language: 'DE', minPkn: 90 },
  ];
  const { ctCheapestPkn, ctMatchedPkn } = pickMatchedCt(groups, 'NM', 'IT');
  assert.equal(ctCheapestPkn, 90);
  assert.equal(ctMatchedPkn, 180);
  // A condition with no CT rows falls back to the overall cheapest.
  const only = pickMatchedCt([{ condition: 'Poor', language: 'FR', minPkn: 40 }], 'NM', 'IT');
  assert.deepEqual(only, { ctCheapestPkn: 40, ctMatchedPkn: null });
  assert.deepEqual(pickMatchedCt([], 'NM', 'IT'), { ctCheapestPkn: null, ctMatchedPkn: null });
});
