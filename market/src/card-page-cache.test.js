import assert from 'node:assert/strict';
import test from 'node:test';
import { peekStoredCardPage, rememberStoredCardPage } from './card-page-cache.js';

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
    clear: () => { store.clear(); },
  };
}

test('card-page cache keeps artist and emoji on the public card id', () => {
  globalThis.localStorage = memoryStorage();
  rememberStoredCardPage('643450', {
    card: {
      id: '643450',
      name: 'Pikachu',
      emoji: '🐭 ⚡',
      artist: 'Kazuki Minami',
      number: 'Illustration Contest 2024 | SVP 214',
      version: 'v321725',
    },
    version: 'v321725',
    versionCount: 2,
    artist: { name: 'Kazuki Minami', illustrator: 'Kazuki Minami' },
  });
  const peeked = peekStoredCardPage('643450');
  assert.equal(peeked.card.name, 'Pikachu');
  assert.equal(peeked.card.emoji, '🐭 ⚡');
  assert.equal(peeked.card.artist, 'Kazuki Minami');
  assert.equal(peeked.card.number, 'Illustration Contest 2024 | SVP 214');
  assert.equal(peeked.version, 'v321725');
  assert.equal(peeked.card.version, 'v321725');
});
