import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POKO_PEER,
  isPokoPeer,
  pokoPreview,
  readPokoHistory,
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
