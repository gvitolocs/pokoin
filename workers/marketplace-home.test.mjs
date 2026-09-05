import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleHomeVector, isHomePath, stableHomeCacheRequest } from './marketplace-home.js';

test('home paths include the cached vector API and the old page alias', () => {
  assert.equal(isHomePath('/api/marketplace-home'), true);
  assert.equal(isHomePath('/api/marketplace-home-page'), true);
  assert.equal(isHomePath('/api/marketplace-search-page'), false);
});

test('edge cache key is stable — no supabase version round-trip on the user path', () => {
  const request = stableHomeCacheRequest('https://pokoin.com/api/marketplace-home?v=units7d');
  assert.equal(new URL(request.url).pathname, '/api/marketplace-home');
  assert.equal(new URL(request.url).search, '');
});

test('assembles one vector from Supabase rails without recently seen', () => {
  const vector = assembleHomeVector(
    [
      {
        id: 'new_cards',
        meta: { pknUsdt: 0.005 },
        cards: [{ id: '1', name: 'Lucario', price: 30128 }],
      },
      {
        id: 'best_sellers',
        cards: [{ card_id: '2', name: 'Dragonite', lowest_price_pkn: 12658 }],
      },
      {
        id: 'featured',
        cards: [{ id: '1', name: 'Lucario', price: null }],
      },
    ],
    '2026-09-01T00:00:00.000Z',
  );
  assert.equal(vector.source, 'supabase');
  assert.equal(vector.cacheTtl, 86400);
  assert.deepEqual(vector.sections.newArrivalIds, ['1']);
  assert.deepEqual(vector.sections.bestSellerIds, ['2']);
  assert.equal(vector.sections.recentlySeenIds, undefined);
  const lucario = vector.cards.find((card) => card.id === '1');
  assert.equal(lucario.price, 30128);
  assert.equal(vector.cards.length, 2);
});
