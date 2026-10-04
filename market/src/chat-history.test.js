import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_PAGE,
  historyKey,
  mergeChatEvents,
  nearChatTop,
  pageHasMore,
  readChatHistory,
  chatPreviewsLookSame,
  mergeChatPreviewRows,
  paintableChatPreviews,
  readChatPreviews,
  writeChatHistory,
  writeChatPreviews,
} from './chat-history.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

function event(id, at) {
  return { id, createdAt: at, text: id };
}

test('a conversation keeps the latest page in this browser', () => {
  const key = historyKey({ peerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2' });
  const events = Array.from({ length: 140 }, (_, index) => event(String(index + 1), index + 1));
  writeChatHistory(key, events, true);
  const saved = readChatHistory(key);
  assert.equal(saved.events.length, CHAT_PAGE);
  assert.equal(saved.events[0].id, '41');
  assert.equal(saved.events.at(-1).id, '140');
  assert.equal(saved.hasMore, true);
});

test('the messages page reads the thread saved from the side panel', () => {
  const uid = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';
  writeChatHistory(historyKey({ peerUid: uid }), [event('9', 9)], false, { peerUid: uid, username: 'redshakkio' });
  const saved = readChatHistory(historyKey({ peer: 'redshakkio' }));
  assert.equal(saved.events[0].id, '9');
  assert.equal(saved.hasMore, false);
});

test('newer messages join the cached thread without dropping older ones', () => {
  const merged = mergeChatEvents(
    [event('1', 1), event('2', 2)],
    [event('2', 2), event('3', 3)],
  );
  assert.deepEqual(merged.map((row) => row.id), ['1', '2', '3']);
  const replaced = mergeChatEvents([event('2', 2)], [{ ...event('2', 2), text: 'edited' }]);
  assert.equal(replaced[0].text, 'edited');
});

test('the message list keeps the last preview in this browser', () => {
  writeChatPreviews([
    {
      pairKey: 'direct_a',
      peerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
      peerUsername: 'redshakkio',
      peerDisplayName: 'RotationMotionTCG',
      peerPhotoUrl: 'https://cdn.pokoin.com/profile-pictures/a.jpg',
      preview: 'Mega Rayquaza ex',
      unread: 0,
      updatedAt: '2026-09-25T13:50:00.000Z',
    },
    { preview: 'no one' },
  ]);
  const saved = readChatPreviews();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].peerUsername, 'redshakkio');
  assert.equal(saved[0].peerDisplayName, 'RotationMotionTCG');
  assert.equal(saved[0].peerPhotoUrl, 'https://cdn.pokoin.com/profile-pictures/a.jpg');
  assert.equal(saved[0].preview, 'Mega Rayquaza ex');
  assert.equal(paintableChatPreviews().length, 1);
});

test('a saved handle without a display name is not painted', () => {
  writeChatPreviews([{
    pairKey: 'direct_a',
    peerUid: 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2',
    peerUsername: 'redshakkio',
    preview: 'Mega Rayquaza ex',
  }]);
  assert.equal(paintableChatPreviews().length, 0);
});

test('the same person and preview is not a new list paint', () => {
  const row = {
    peerUid: 'uid-1',
    peerDisplayName: 'RotationMotionTCG',
    peerPhotoUrl: 'https://cdn.pokoin.com/profile-pictures/a.jpg',
    preview: 'Mega Rayquaza ex',
    unread: 0,
    updatedAt: '2026-09-28T12:00:00.000Z',
  };
  assert.equal(chatPreviewsLookSame([row], [{ ...row }]), true);
  assert.equal(chatPreviewsLookSame([row], [{ ...row, preview: 'other' }]), false);
});

test('a refresh keeps the name and photo when the new row omits them', () => {
  const merged = mergeChatPreviewRows(
    [{
      peerUid: 'uid-1',
      peerUsername: 'redshakkio',
      peerDisplayName: 'RotationMotionTCG',
      peerPhotoUrl: 'https://cdn.pokoin.com/profile-pictures/a.jpg',
    }],
    [{ peerUid: 'uid-1', peerUsername: 'redshakkio', preview: 'Mega Rayquaza ex' }],
  );
  assert.equal(merged[0].peerDisplayName, 'RotationMotionTCG');
  assert.equal(merged[0].peerPhotoUrl, 'https://cdn.pokoin.com/profile-pictures/a.jpg');
  assert.equal(merged[0].preview, 'Mega Rayquaza ex');
});

test('scrolling to the top is the cue to fetch older messages', () => {
  assert.equal(nearChatTop(0), true);
  assert.equal(nearChatTop(48), true);
  assert.equal(nearChatTop(49), false);
  assert.equal(pageHasMore({ hasMore: false, events: Array.from({ length: 100 }, (_, i) => event(String(i), i)) }), false);
  assert.equal(pageHasMore({ events: Array.from({ length: 100 }, (_, i) => event(String(i), i)) }), true);
});
