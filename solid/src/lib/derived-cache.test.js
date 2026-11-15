import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { memoizeByRows, memoizePair } from './derived-cache.js';

test('memoizeByRows walks a book once and recomputes for a new one', () => {
  let calls = 0;
  const rowsCost = memoizeByRows((rows) => { calls += 1; return (rows || []).length; });
  const book = [{ id: '1' }, { id: '2' }];
  assert.equal(rowsCost(book), 2);
  assert.equal(rowsCost(book), 2);
  assert.equal(calls, 1, 'the same array is not walked again');
  assert.equal(rowsCost([...book]), 2);
  assert.equal(calls, 2, 'a new book is a new walk');
  assert.equal(rowsCost(null), 0);
  assert.equal(rowsCost(null), 0);
  assert.equal(calls, 4, 'a missing book is not cached');
});

test('memoizePair remembers per pair and drops the hit when either input moves', () => {
  let calls = 0;
  const split = memoizePair((rows, listings) => { calls += 1; return `${rows.length}:${listings.length}`; });
  const rows = [{ id: '1' }];
  const listings = [{ id: 'a' }, { id: 'b' }];
  assert.equal(split(rows, listings), '1:2');
  assert.equal(split(rows, listings), '1:2');
  assert.equal(calls, 1);
  assert.equal(split(rows, [{ id: 'a' }]), '1:1');
  assert.equal(calls, 2, 'new listings recompute');
});
