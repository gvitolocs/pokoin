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
  pokoEventsSignature,
  resolvePokoCards,
  setActiveDeskCard,
  tagsToPokoCards,
  writePokoHistory,
  pokoUserTurnKey,
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
  const store = Object.create(null);
  globalThis.localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
  };
  store['pokoin.watchlistIds'] = JSON.stringify(['111', '222']);
  store['pokoin.cartItems'] = JSON.stringify([
    { id: 'c1', cardId: '333', name: 'Cart Card', qty: 2, pricePkn: 50 },
  ]);
  const cards = tagsToPokoCards([{ id: '246912', name: 'Noivern V', setName: 'Evolving Skies' }]);
  const ctx = buildPokoPageContext({ pathname: '/marketplace/en/cards/246912', cards });
  assert.equal(ctx.deskCardId, '246912');
  assert.equal(ctx.channel, 'website-messages');
  assert.deepEqual(ctx.watchlistIds, ['111', '222']);
  assert.equal(ctx.cart[0].cardId, '333');
  assert.equal(ctx.cart[0].qty, 2);
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
  writePokoHistory(uid, [{ id: '1', text: 'hello', mine: true }], false);
  assert.equal(readPokoHistory(uid).events[0].text, 'hello');
  assert.equal(readPokoHistory(uid).hasMore, false);
});

test('poko history cache keeps the last page and remembers hasMore', () => {
  const uid = 'test-poko-page';
  const store = Object.create(null);
  globalThis.localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
  };
  const rows = Array.from({ length: 35 }, (_, i) => ({
    id: String(i + 1),
    text: `m${i + 1}`,
    mine: i % 2 === 0,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  }));
  writePokoHistory(uid, rows, true);
  const cached = readPokoHistory(uid);
  assert.equal(cached.events.length, 20);
  assert.equal(cached.events[0].id, '16');
  assert.equal(cached.events[19].id, '35');
  assert.equal(cached.hasMore, true);
});

test('mergePokoEvents and reconcile keep unmatched local optimistic rows', () => {
  const merged = mergePokoEvents(
    [{ id: 'a', text: 'hi', mine: true, createdAt: '2026-01-01T00:00:00.000Z' }],
    [{ id: 'b', text: 'yo', mine: false, createdAt: '2026-01-01T00:00:01.000Z' }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'a');
  const matched = reconcilePokoEvents(
    [{ id: 'local-1', text: 'pending', mine: true }, { id: 'a', text: 'hi', mine: true }],
    [{ id: 'a', text: 'hi', mine: true }, { id: 'srv', text: 'pending', mine: true }, { id: 'b', text: 'yo', mine: false }],
  );
  assert.equal(matched.some((row) => String(row.id).startsWith('local-')), false);
  assert.equal(matched.length, 3);
  const pending = reconcilePokoEvents(
    [{ id: 'local-2', text: 'still sending', mine: true }, { id: 'a', text: 'hi', mine: true }],
    [{ id: 'a', text: 'hi', mine: true }],
  );
  assert.equal(pending.some((row) => row.id === 'local-2'), true);
  assert.equal(pending.length, 2);
});

test('reconcile keeps card-attached local rows until the server twin includes the card', () => {
  const local = {
    id: 'local-card',
    text: 'quanto vale',
    mine: true,
    cards: [{ cardId: '123', name: 'Gengar & Mimikyu GX' }],
  };
  const stillPending = reconcilePokoEvents(
    [local],
    [{ id: 'old', text: 'quanto vale', mine: true, cards: [] }],
  );
  assert.equal(stillPending.some((row) => row.id === 'local-card'), true);

  const replaced = reconcilePokoEvents(
    [local],
    [{
      id: 'srv-user',
      text: 'quanto vale',
      mine: true,
      cards: [{ cardId: '123', name: 'Gengar & Mimikyu GX' }],
    }, {
      id: 'srv-bot',
      text: 'Checking…',
      mine: false,
    }],
  );
  assert.equal(replaced.some((row) => row.id === 'local-card'), false);
  assert.equal(replaced.some((row) => row.id === 'srv-user'), true);
  assert.equal(pokoUserTurnKey(local), pokoUserTurnKey(replaced.find((row) => row.id === 'srv-user')));
});

test('pokoEventsSignature is stable for identical content so idle polls can skip setState', () => {
  const a = [
    { id: '1', role: 'user', text: 'hi', source: '', images: [], cards: [] },
    { id: '2', role: 'assistant', text: 'yo', source: 'hermes', images: [], cards: [] },
  ];
  const b = a.map((row) => ({ ...row }));
  assert.equal(pokoEventsSignature(a), pokoEventsSignature(b));
  assert.notEqual(
    pokoEventsSignature(a),
    pokoEventsSignature([{ ...a[0] }, { ...a[1], text: 'changed' }]),
  );
});
