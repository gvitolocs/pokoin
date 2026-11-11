import assert from 'node:assert/strict';
import test from 'node:test';
import { stackOrder } from './price-stack.js';

const pair = { local: '0.36 DKK', pkn: '71 PKN' };

test('a two-line price stacks local over PKN unless it is flipped', () => {
  assert.deepEqual(stackOrder(pair), ['local', 'pkn']);
  assert.deepEqual(stackOrder(pair, true), ['pkn', 'local']);
});

test('a single price has no order to flip', () => {
  assert.equal(stackOrder({ local: '0.98 DKK', pkn: '' }, true), null);
  assert.equal(stackOrder({ local: '', pkn: '71 PKN' }, true), null);
  assert.equal(stackOrder(null, true), null);
});
