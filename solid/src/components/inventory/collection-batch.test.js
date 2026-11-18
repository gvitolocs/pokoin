import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { COLLECTION_BATCH_SIZE, nextCollectionBatch } from './collection-batch.js';

test('collection batches reveal rows up to the filtered count', () => {
  assert.equal(nextCollectionBatch(0, 1500), COLLECTION_BATCH_SIZE);
  assert.equal(nextCollectionBatch(40, 65), 65);
  assert.equal(nextCollectionBatch(80, 10), 10);
  assert.equal(nextCollectionBatch(0, 0), 0);
});
