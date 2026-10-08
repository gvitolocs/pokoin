import assert from 'node:assert/strict';
import test from 'node:test';
import {
  homeVectorCacheKey,
  readHomeVectorCache,
  stripHomePersonalization,
  writeHomeVectorCache,
} from './home-cache.js';

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

test('home cache drops recently seen before save', () => {
  const payload = {
    cards: [{ id: '1', name: 'Lucario' }],
    sections: { newArrivalIds: ['1'], recentlySeenIds: ['9'] },
    missingRecentIds: ['9'],
  };
  const stripped = stripHomePersonalization(payload);
  assert.deepEqual(stripped.sections.recentlySeenIds, undefined);
  assert.equal(stripped.missingRecentIds, undefined);
  assert.deepEqual(stripped.sections.newArrivalIds, ['1']);
});

test('session cache round-trips the public vector', () => {
  const store = memoryStore();
  writeHomeVectorCache('pokemon', {
    cards: [{ id: '1' }],
    sections: { recentlySeenIds: ['2'], newArrivalIds: ['1'] },
  }, store);
  const cached = readHomeVectorCache('pokemon', store);
  assert.equal(cached.cards[0].id, '1');
  assert.equal(cached.sections.recentlySeenIds, undefined);
  assert.equal(homeVectorCacheKey('pokemon'), 'pokoin.homeVector.pokemon.v4');
});

test('home cache refuses a Pokemon vector under a satellite game id', () => {
  const store = memoryStore();
  writeHomeVectorCache('magic', {
    game: 'pokemon',
    cards: [{ id: '1', name: 'Mega Rayquaza ex' }],
    sections: { newArrivalIds: ['1'] },
  }, store);
  assert.equal(readHomeVectorCache('magic', store), null);
  writeHomeVectorCache('magic', {
    game: 'magic',
    cards: [{ id: '2', name: 'Omnipresence' }],
    sections: { newArrivalIds: ['2'] },
  }, store);
  assert.equal(readHomeVectorCache('magic', store)?.cards[0].name, 'Omnipresence');
});
