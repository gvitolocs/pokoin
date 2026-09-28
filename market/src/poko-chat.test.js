import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POKO_PEER,
  buildPokoPageContext,
  cleanPokoImages,
  clearActiveDeskCard,
  defaultPokoDeskPrompt,
  deskCardFromPath,
  isPokoPeer,
  mergePokoEvents,
  pokoPreview,
  readPokoHistory,
  reconcilePokoEvents,
  resolvePokoCards,
  setActiveDeskCard,
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

test('deskCardFromPath and resolvePokoCards prefer live desk then URL', () => {
  clearActiveDeskCard();
  const fromPath = deskCardFromPath('/marketplace/en/cards/246912/card-noivern-v-full-art-195-196-evolving-skies');
  assert.equal(fromPath.cardId, '246912');
  assert.match(fromPath.name, /Noivern/i);
  assert.equal(resolvePokoCards({ pathname: fromPath.canonicalPath })[0].cardId, '246912');
  setActiveDeskCard({ id: '99', name: 'Live Desk', set: 'SV' });
  assert.equal(resolvePokoCards({ pathname: fromPath.canonicalPath })[0].cardId, '99');
  assert.equal(resolvePokoCards({ tags: [{ id: '7', name: 'Tagged' }], pathname: fromPath.canonicalPath })[0].cardId, '7');
  clearActiveDeskCard();
});

test('buildPokoPageContext and defaultPokoDeskPrompt lead with analytics', () => {
  const cards = tagsToPokoCards([{ id: '246912', name: 'Noivern V', setName: 'Evolving Skies' }]);
  const ctx = buildPokoPageContext({ pathname: '/marketplace/en/cards/246912', cards });
  assert.equal(ctx.deskCardId, '246912');
  assert.equal(ctx.channel, 'website-messages');
  assert.match(defaultPokoDeskPrompt(cards[0]), /sold median/i);
  assert.match(defaultPokoDeskPrompt(cards[0]), /246912/);
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

test('mergePokoEvents and reconcile drop local optimistic rows', () => {
  const merged = mergePokoEvents(
    [{ id: 'a', text: 'hi', mine: true, createdAt: '2026-01-01T00:00:00.000Z' }],
    [{ id: 'b', text: 'yo', mine: false, createdAt: '2026-01-01T00:00:01.000Z' }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'a');
  const reconciled = reconcilePokoEvents(
    [{ id: 'local-1', text: 'pending', mine: true }, { id: 'a', text: 'hi', mine: true }],
    [{ id: 'a', text: 'hi', mine: true }, { id: 'b', text: 'yo', mine: false }],
  );
  assert.equal(reconciled.some((row) => String(row.id).startsWith('local-')), false);
  assert.equal(reconciled.length, 2);
});
