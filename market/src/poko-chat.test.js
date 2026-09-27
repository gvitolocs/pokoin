import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POKO_PEER,
  cleanPokoImages,
  isPokoPeer,
  pokoPreview,
  readPokoHistory,
  tagsToPokoCards,
  writePokoHistory,
} from './poko-chat.js';

test('isPokoPeer recognizes reserved peer', () => {
  assert.equal(isPokoPeer('poko'), true);
  assert.equal(isPokoPeer('Poko'), true);
  assert.equal(isPokoPeer('redshakkio'), false);
  assert.equal(POKO_PEER, 'poko');
});

test('pokoPreview falls back and prefers last text', () => {
  assert.match(pokoPreview([]), /Ask about cards/);
  assert.equal(pokoPreview([{ text: 'hi' }, { text: 'worth?' }]), 'worth?');
  assert.equal(pokoPreview([{ images: ['https://cdn.pokoin.com/a.jpg'] }]), 'Photo attached');
});

test('tagsToPokoCards and cleanPokoImages sanitize payloads', () => {
  const cards = tagsToPokoCards([{ cardId: '1', cardName: 'Mew', setName: '151' }, { name: '' }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Mew');
  assert.deepEqual(
    cleanPokoImages(['https://cdn.pokoin.com/a.jpg', 'not-a-url', 'javascript:alert(1)']),
    ['https://cdn.pokoin.com/a.jpg'],
  );
});

test('poko history round-trips in localStorage', () => {
  const uid = 'test-poko-uid';
  const store = Object.create(null);
  globalThis.localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
  };
  writePokoHistory(uid, [{ id: '1', text: 'hello', mine: true }]);
  assert.equal(readPokoHistory(uid)[0].text, 'hello');
});
