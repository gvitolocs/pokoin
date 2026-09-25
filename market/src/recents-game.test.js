import assert from 'node:assert/strict';
import test from 'node:test';
import { withGameQuery, gameIdFromHost, sellerDeskUsesGameOverride } from './game.js';

test('hostnames map to canonical game ids used by recents', () => {
  assert.equal(gameIdFromHost('pokoin.com'), 'pokemon');
  assert.equal(gameIdFromHost('onepiece.pokoin.com'), 'one_piece');
  assert.equal(gameIdFromHost('riftbound.pokoin.com'), 'riftbound');
});

test('scan game picker applies on /dashboard, not on the marketplace', () => {
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/dashboard'), true);
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/dashboard/scan'), true);
  assert.equal(sellerDeskUsesGameOverride('www.pokoin.com', '/dashboard/'), true);
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/marketplace'), false);
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/scan'), false);
  assert.equal(sellerDeskUsesGameOverride('dashboard.pokoin.com', '/'), true);
  assert.equal(sellerDeskUsesGameOverride('localhost', '/marketplace'), true);
  assert.equal(sellerDeskUsesGameOverride('onepiece.pokoin.com', '/dashboard'), false);
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

test('withGameQuery scopes marketplace-card-tiles on satellite hosts', () => {
  assert.equal(
    withGameQuery('/api/marketplace-card-tiles?ids=1,2', 'riftbound.pokoin.com'),
    '/api/marketplace-card-tiles?ids=1,2&game=riftbound',
  );
  assert.equal(
    withGameQuery('/api/marketplace-card-tiles?ids=1', 'onepiece.pokoin.com'),
    '/api/marketplace-card-tiles?ids=1&game=one_piece',
  );
});
