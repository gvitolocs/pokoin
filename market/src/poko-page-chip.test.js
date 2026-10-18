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
  clearChatTags,
  closeChatDock,
  getChatDock,
  getChatDrafts,
  openThread,
  removeChatTag,
  setChatTagQty,
  syncPokoPageChip,
} = await import('./chat-dock-store.js');
const {
  buildPokoPageContext,
  clearActiveDeskCard,
  getActiveDeskCard,
  reconcilePokoPageChip,
  setActiveDeskCard,
  subscribeActiveDeskCard,
  tagsToPokoCards,
} = await import('./poko-chat.js');
const { tagKey } = await import('./chat-listing.js');

const foongus = { id: '250366', name: 'Foongus', set: 'Plasma Storm', canonicalPath: '/marketplace/en/cards/250366/card-foongus-12-135-plasma-storm' };
const pikachu = { id: '25', name: 'Pikachu', set: 'Base Set', canonicalPath: '/marketplace/en/cards/25/card-pikachu' };
const SELLER = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';

/** What ChatDock sends Poko for the composer's tags. */
function pokoPayload(tags) {
  const cards = tagsToPokoCards(tags);
  return { cards, pageContext: buildPokoPageContext({ pathname: foongus.canonicalPath, cards }) };
}

function pageChips() {
  return getChatDock().tags.filter((row) => row.pageCard);
}

test('the desk card publishes as a chat card reference and notifies once per change', () => {
  const seen = [];
  const stop = subscribeActiveDeskCard((row) => seen.push(row?.cardId || null));
  setActiveDeskCard(foongus);
  setActiveDeskCard(foongus);
  assert.equal(getActiveDeskCard().kind, 'card');
  assert.equal(getActiveDeskCard().cardId, '250366');
  assert.equal(getActiveDeskCard().cardName, 'Foongus');
  clearActiveDeskCard();
  stop();
  assert.deepEqual(seen, ['250366', null]);
});

test('chip present: opening Poko on a card desk attaches that card visibly, and only then is it sent', () => {
  setActiveDeskCard(foongus);
  openThread('poko', 'Poko');
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  assert.equal(pageChips().length, 1);
  assert.equal(pageChips()[0].cardId, '250366');
  assert.equal(pageChips()[0].qty, 1);
  setChatTagQty(tagKey(pageChips()[0]), 3);
  assert.equal(pageChips()[0].qty, 3);
  const { cards, pageContext } = pokoPayload(getChatDock().tags);
  assert.equal(cards[0].cardId, '250366');
  assert.equal(pageContext.deskCardId, '250366');
  // The chip follows the page; it is never saved as a draft.
  closeChatDock('');
  assert.equal(getChatDrafts().poko, undefined);
  clearActiveDeskCard();
});

test('chip removed: × turns the page card off, so Poko gets no card at all', () => {
  setActiveDeskCard(foongus);
  openThread('poko', 'Poko');
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  removeChatTag(tagKey(pageChips()[0]));
  // ChatDock records the × as off for this conversation.
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: true, used: [] });
  assert.deepEqual(getChatDock().tags, []);
  const { cards, pageContext } = pokoPayload(getChatDock().tags);
  assert.deepEqual(cards, []);
  assert.equal(pageContext.deskCardId, '');
  assert.equal(pageContext.deskCardName, '');
  // Navigating to another card keeps it off for this conversation.
  setActiveDeskCard(pikachu);
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: true, used: [] });
  assert.deepEqual(getChatDock().tags, []);
  closeChatDock('');
  clearActiveDeskCard();
});

test('seller chat: the viewed card is never proposed or sent', () => {
  setActiveDeskCard(foongus);
  openThread(SELLER, 'redshakkio');
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  assert.deepEqual(pageChips(), []);
  assert.deepEqual(getChatDock().tags, []);
  closeChatDock('');
  clearActiveDeskCard();
});

test('navigating swaps an unsent chip for the new card; leaving card desks drops it', () => {
  setActiveDeskCard(foongus);
  openThread('poko', 'Poko');
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  setActiveDeskCard(pikachu);
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  assert.deepEqual(pageChips().map((row) => row.cardId), ['25']);
  clearActiveDeskCard();
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  assert.deepEqual(getChatDock().tags, []);
  closeChatDock('');
});

test('a sent chip is not offered again for the same card, but a new card is', () => {
  setActiveDeskCard(foongus);
  openThread('poko', 'Poko');
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  clearChatTags();
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: ['250366'] });
  assert.deepEqual(getChatDock().tags, []);
  setActiveDeskCard(pikachu);
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: ['250366'] });
  assert.deepEqual(pageChips().map((row) => row.cardId), ['25']);
  closeChatDock('');
  clearActiveDeskCard();
});

test('dropping the viewed card yourself makes it an ordinary attachment that survives navigation', () => {
  setActiveDeskCard(foongus);
  openThread('poko', 'Poko');
  syncPokoPageChip({ pageCard: getActiveDeskCard(), off: false, used: [] });
  addChatTag(getActiveDeskCard());
  assert.equal(getChatDock().tags.length, 1);
  assert.equal(getChatDock().tags[0].pageCard, undefined);
  clearActiveDeskCard();
  syncPokoPageChip({ pageCard: null, off: false, used: [] });
  assert.equal(getChatDock().tags[0].cardId, '250366');
  clearChatTags();
  closeChatDock('');
});

test('reconcilePokoPageChip returns the same array when nothing changes', () => {
  const tags = [{ kind: 'card', cardId: '9', cardName: 'Meowth', qty: 1 }];
  assert.equal(reconcilePokoPageChip(tags, { poko: false }), tags);
  assert.equal(reconcilePokoPageChip(tags, { poko: true, pageCard: { kind: 'card', cardId: '9', cardName: 'Meowth' } }), tags);
  const full = [1, 2, 3, 4].map((n) => ({ kind: 'card', cardId: String(n), cardName: `C${n}` }));
  assert.equal(reconcilePokoPageChip(full, { poko: true, pageCard: { kind: 'card', cardId: '99', cardName: 'X' } }), full);
});
