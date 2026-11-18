import assert from 'node:assert/strict';
import test from 'node:test';
import { cardHref } from './api.js';

const solRing = {
  id: '822658',
  canonicalPath: '/marketplace/en/cards/822658/sol-ring',
};

function at(pathname) {
  globalThis.window = { location: { hostname: 'pokoin.com', pathname } };
}

test('cardHref prefixes the current game and leaves Pokémon unprefixed', () => {
  at('/magic/marketplace/search');
  assert.equal(cardHref(solRing), '/magic/marketplace/en/cards/822658/sol-ring');
  assert.equal(cardHref({}), '/magic/marketplace');
  assert.equal(
    cardHref({ canonicalPath: '/magic/marketplace/en/cards/822658/sol-ring' }),
    '/magic/marketplace/en/cards/822658/sol-ring',
  );

  at('/marketplace/search');
  assert.equal(cardHref(solRing), '/marketplace/en/cards/822658/sol-ring');
  assert.equal(cardHref({}), '/marketplace');
});
