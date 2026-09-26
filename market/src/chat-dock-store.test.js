import assert from 'node:assert/strict';
import test from 'node:test';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

const {
  addChatTag,
  chatDropHintVisible,
  closeChatDock,
  dismissChatDropHint,
  dropOnConversation,
  getChatDrafts,
  getChatDock,
  beginCardDrag,
  endCardDrag,
  noteListingDrag,
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

test('dragging a card keeps the conversation that is already open', () => {
  const uid = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';
  openThread(uid, 'redshakkio');
  assert.equal(noteListingDrag('still writing'), 'thread');
  assert.equal(getChatDock().view, 'thread');
  assert.equal(getChatDock().peer, uid);
  const trade = { ...card, cardName: 'Pikachu', cardId: '25', imageUrl: '/card-images/25.jpg' };
  assert.equal(addChatTag(trade, 'still writing'), true);
  assert.equal(getChatDock().view, 'thread');
  assert.equal(getChatDock().tags.at(-1).cardName, 'Pikachu');
  assert.equal(getChatDock().text, 'still writing');
});

test('a card drag opens messages and closes them unless the card lands there', () => {
  closeChatDock();
  assert.equal(getChatDock().open, false);
  beginCardDrag();
  assert.equal(getChatDock().open, true);
  assert.equal(getChatDock().view, 'list');
  endCardDrag();
  assert.equal(getChatDock().open, false);

  beginCardDrag();
  assert.equal(dropOnConversation('PUH1ygG9mOOyQRPXaY5Fa1W6DKd2', 'redshakkio', card), true);
  endCardDrag();
  assert.equal(getChatDock().open, true);
  assert.equal(getChatDock().view, 'thread');

  beginCardDrag();
  endCardDrag();
  assert.equal(getChatDock().open, true);
  closeChatDock();
});

test('dismissing the drop hint stays dismissed in this browser', () => {
  assert.equal(chatDropHintVisible(), true);
  dismissChatDropHint();
  assert.equal(chatDropHintVisible(), false);
  assert.equal(memory.get('pokoin.chatDropHint'), 'dismissed');
});
