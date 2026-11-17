import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTabCache } from './tab-cache.js';
test('cache isolates accounts and retains stale values for revalidation', () => {
  let now = 100;
  const cache = createTabCache(30, () => now);
  cache.set('alice', [1]);
  cache.set('', [2]);
  assert.deepEqual(cache.get('alice'), [1]);
  assert.equal(cache.get('bob'), undefined);
  assert.equal(cache.get(''), undefined);
  assert.equal(cache.fresh('alice'), true);
  now += 30;
  assert.equal(cache.fresh('alice'), false);
  assert.deepEqual(cache.get('alice'), [1]);
  cache.delete('alice');
  assert.equal(cache.get('alice'), undefined);
});
