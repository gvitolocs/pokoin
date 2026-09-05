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
  assert.equal(homeVectorCacheKey('pokemon'), 'pokoin.homeVector.pokemon');
});
