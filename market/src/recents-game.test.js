import assert from 'node:assert/strict';
import test from 'node:test';
import { withGameQuery, gameIdFromHost } from './game.js';

test('hostnames map to canonical game ids used by recents', () => {
  assert.equal(gameIdFromHost('pokoin.com'), 'pokemon');
  assert.equal(gameIdFromHost('onepiece.pokoin.com'), 'one_piece');
  assert.equal(gameIdFromHost('riftbound.pokoin.com'), 'riftbound');
});

test('withGameQuery scopes marketplace-recents on satellite hosts', () => {
  assert.equal(
    withGameQuery('/api/marketplace-recents', 'pokoin.com'),
    '/api/marketplace-recents',
  );
  assert.equal(
    withGameQuery('/api/marketplace-recents', 'riftbound.pokoin.com'),
    '/api/marketplace-recents?game=riftbound',
  );
  assert.equal(
    withGameQuery('/api/marketplace-recents', 'onepiece.pokoin.com'),
    '/api/marketplace-recents?game=one_piece',
  );
});
