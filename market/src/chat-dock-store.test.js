import assert from 'node:assert/strict';
import test from 'node:test';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

const {
  closeChatDock,
  dropOnConversation,
  getChatDrafts,
  getChatDock,
  openThread,
} = await import('./chat-dock-store.js');

const card = {
  kind: 'card',
  cardName: 'Meowth',
  cardId: '9',
  imageUrl: '/card-images/9.jpg',
  path: '/marketplace/en/cards/9',
};

test('a dropped card stays on that conversation after the panel closes', () => {
  const uid = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';
  assert.equal(dropOnConversation(uid, 'redshakkio', card), true);
  assert.equal(getChatDock().view, 'thread');
  assert.equal(getChatDock().tags[0].cardName, 'Meowth');
  closeChatDock('still writing');
  assert.equal(getChatDock().open, false);
  assert.equal(getChatDrafts()[uid].tags[0].cardName, 'Meowth');
  assert.equal(getChatDrafts()[uid].text, 'still writing');
  openThread(uid, 'redshakkio');
  assert.equal(getChatDock().tags[0].imageUrl, '/card-images/9.jpg');
  assert.equal(getChatDock().text, 'still writing');
});
