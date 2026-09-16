import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandProvisionalCardIds,
  leftoverCdnId,
  provisionalPublicCardId,
  realPublicCardId,
  rewriteLeftoverCatalogImage,
} from './public-card-id.js';

test('999 Storm Emeralda placeholders rewrite to leftover × 2', () => {
  assert.equal(realPublicCardId('999806370'), '806370');
  assert.equal(provisionalPublicCardId('806370'), '999806370');
  assert.deepEqual(expandProvisionalCardIds(['999806370']), ['806370', '999806370']);
});

test('image keys use leftover ct_id, not public id', () => {
  assert.equal(leftoverCdnId('245292'), '122646');
  assert.equal(leftoverCdnId('248768'), '124384');
  assert.equal(
    rewriteLeftoverCatalogImage('/card-images/245292_net-ball.jpg', '245292'),
    '/card-images/122646_net-ball.jpg',
  );
  assert.equal(
    rewriteLeftoverCatalogImage('/card-images/248768_drifloon-lv-17.jpg?v=br4', '248768'),
    '/card-images/124384_drifloon-lv-17.jpg?v=br4',
  );
});
