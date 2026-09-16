import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleHomeVector, homeOriginFailureResponse, isHomePath, stableHomeCacheRequest } from './marketplace-home.js';
import { WORKING_MESSAGE } from './working-page.js';

test('home paths include the cached vector API and the old page alias', () => {
  assert.equal(isHomePath('/api/marketplace-home'), true);
  assert.equal(isHomePath('/api/marketplace-home-page'), true);
  assert.equal(isHomePath('/api/marketplace-search-page'), false);
});

test('edge cache key is stable — stable cache key on the user path', () => {
  const request = stableHomeCacheRequest('https://pokoin.com/api/marketplace-home?v=rising-month');
  assert.equal(new URL(request.url).pathname, '/api/marketplace-home');
  assert.equal(new URL(request.url).search, '');
});

test('assembles one vector from Pi rails without recently seen', () => {
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
  assert.equal(vector.source, 'pi');
  assert.equal(vector.cacheTtl, 86400);
  assert.deepEqual(vector.sections.newArrivalIds, ['1']);
  assert.deepEqual(vector.sections.bestSellerIds, ['2']);
  assert.equal(vector.sections.recentlySeenIds, undefined);
  const lucario = vector.cards.find((card) => card.id === '1');
  assert.equal(lucario.price, 30128);
  assert.equal(vector.cards.length, 2);
});

test('Pi/Postgres failure is 503 working JSON, not a Node errno', async () => {
  const down = homeOriginFailureResponse();
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('x-pokoin-working'), '1');
  assert.deepEqual(await down.json(), { error: WORKING_MESSAGE });
});

test('new_cards rail keeps twenty curated ids in published order', () => {
  const cards = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1),
    name: index % 3 === 0 ? 'Mega Rayquaza ex' : `Card ${index + 1}`,
    number: `${String(113 - index).padStart(3, '0')}/076`,
  }));
  const vector = assembleHomeVector([{ id: 'new_cards', cards }]);
  assert.equal(vector.sections.newArrivalIds.length, 20);
  assert.deepEqual(vector.sections.newArrivalIds, cards.map((card) => card.id));
});

test('featured rail keeps thirty 30th Anniversary ids', () => {
  const cards = Array.from({ length: 30 }, (_, index) => ({
    id: String(index + 1),
    name: `Anniversary ${index + 1}`,
    set: '30th Celebration JP',
  }));
  const vector = assembleHomeVector([{ id: 'featured', cards }]);
  assert.equal(vector.sections.featuredIds.length, 30);
  assert.deepEqual(vector.sections.featuredIds, cards.map((card) => card.id));
});
