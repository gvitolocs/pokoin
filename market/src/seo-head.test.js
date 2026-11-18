import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUrl } from './seo-head.js';

const origin = 'https://pokoin.com';

test('a game site canonical keeps the game slug', () => {
  // /one-piece/marketplace/sets/treasure-cup used to canonicalize to the
  // unprefixed Pokémon URL, which 404s and is what got indexed and shared.
  const pathname = '/one-piece/marketplace/sets/treasure-cup';
  assert.equal(
    canonicalUrl('/marketplace/sets/treasure-cup', { origin, pathname }),
    'https://pokoin.com/one-piece/marketplace/sets/treasure-cup',
  );
  assert.equal(
    canonicalUrl('/marketplace/sets/radiance', { origin, pathname: '/riftbound/marketplace/sets/radiance' }),
    'https://pokoin.com/riftbound/marketplace/sets/radiance',
  );
  // Card desks already pass the prefixed path.
  assert.equal(
    canonicalUrl('/magic/marketplace/en/cards/822658/sol-ring', { origin, pathname: '/magic/marketplace/en/cards/822658' }),
    'https://pokoin.com/magic/marketplace/en/cards/822658/sol-ring',
  );
});

test('Pokémon, absolute and missing canonicals are unchanged', () => {
  assert.equal(
    canonicalUrl('/marketplace/sets/151', { origin, pathname: '/marketplace/sets/151' }),
    'https://pokoin.com/marketplace/sets/151',
  );
  assert.equal(
    canonicalUrl('https://pokoin.com/marketplace/sets/151', { origin, pathname: '/one-piece/marketplace' }),
    'https://pokoin.com/marketplace/sets/151',
  );
  assert.equal(canonicalUrl('', { origin, pathname: '/one-piece/marketplace/sets' }), 'https://pokoin.com/one-piece/marketplace/sets');
  // Apex-only pages are never prefixed.
  assert.equal(canonicalUrl('/wallet', { origin, pathname: '/one-piece/wallet' }), 'https://pokoin.com/wallet');
});
