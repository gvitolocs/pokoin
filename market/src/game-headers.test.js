import assert from 'node:assert/strict';
import test from 'node:test';
import { gameHeadersForUrl } from './game.js';

const headers = { 'x-pokoin-game': 'magic', 'x-pokoin-host': 'magic.pokoin.com' };

test('a URL that names its satellite game sends no game headers (no CORS preflight)', () => {
  assert.deepEqual(gameHeadersForUrl('https://api.pokoin.com/api/marketplace-home-page?game=magic', headers), {});
  assert.deepEqual(gameHeadersForUrl('/api/marketplace-card-tiles?ids=1,2&marketplaceGame=yugioh#x', headers), {});
});

test('game headers stay when the URL does not name a satellite game', () => {
  assert.equal(gameHeadersForUrl('/api/marketplace-recents', headers), headers);
  assert.equal(gameHeadersForUrl('/api/marketplace-home-page?game=pokemon', headers), headers);
  assert.equal(gameHeadersForUrl('/api/marketplace-home-page?game=', headers), headers);
  assert.deepEqual(gameHeadersForUrl('/api/x?game=magic', {}), {});
});
