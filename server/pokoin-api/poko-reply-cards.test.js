'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const {
  attachReplyCards,
  extractReplyCardMentions,
  REPLY_CARDS_DIRECTIVE,
} = require('./_poko_reply_cards');

// Catalog stand-in for marketplace_search_candidates.
const CATALOG = [
  { card_id: '242670', name: 'Jessie & James', set_name: 'Hidden Fates', search_weight: 14, item_kind: 'single' },
  { card_id: '539716', name: 'Jessie & James', set_name: 'Sky Legend', search_weight: 9, item_kind: 'single' },
  { card_id: '800100', name: 'Iono', set_name: 'Paldea Evolved', search_weight: 30, item_kind: 'single' },
  { card_id: '713650', name: 'Mimikyu', set_name: 'Phantasmal Flames', search_weight: 5, item_kind: 'single' },
];

async function fakeQuery(sql, [values]) {
  if (sql.includes('card_id::text = any')) {
    return { rows: CATALOG.filter((row) => values.includes(row.card_id)) };
  }
  if (sql.includes('lower(s.name) = any')) {
    const rows = CATALOG.filter((row) => values.includes(row.name.toLowerCase()))
      .sort((a, b) => b.search_weight - a.search_weight);
    return { rows };
  }
  throw new Error(`unexpected sql ${sql}`);
}

test('the reply from the screenshot gets the Jessie & James card image', async () => {
  const reply = 'carta con due personaggi storici Vecchia scuola: - Jessie & James (Team Rocket) — le due icone cattive per eccellenza, compaiono in diverse edizioni';
  const out = await attachReplyCards(reply, { query: fakeQuery });
  assert.equal(out.text, reply);
  assert.deepEqual(out.cards.map((c) => [c.cardId, c.cardName, c.setName]), [['242670', 'Jessie & James', 'Hidden Fates']]);
});

test('the hidden [[cards: …]] line is stripped and resolves ids and names', async () => {
  const out = await attachReplyCards('Ecco due supporter.\n[[cards: 713650 | Iono]]', { query: fakeQuery });
  assert.equal(out.text, 'Ecco due supporter.');
  assert.deepEqual(out.cards.map((c) => c.cardId), ['713650', '800100']);
});

test('names that are not exact catalog cards are dropped, never guessed', async () => {
  const out = await attachReplyCards('- Vecchia scuola — tante carte\n- **Team Rocket** trainers', { query: fakeQuery });
  assert.deepEqual(out.cards, []);
});

test('structured cards from Hermes win and are capped at six', async () => {
  const out = await attachReplyCards('text', { hermesCards: [{ cardId: '800100' }, '713650', 'junk'], query: fakeQuery });
  assert.deepEqual(out.cards.map((c) => c.cardId), ['800100', '713650']);
  const many = extractReplyCardMentions(Array.from({ length: 9 }, (_, i) => `- Card${i} — x`).join('\n'));
  assert.equal(many.names.length, 9);
});

test('a catalog failure still returns the reply text', async () => {
  const out = await attachReplyCards('- Iono — ok', { query: async () => { throw new Error('db down'); } });
  assert.equal(out.text, '- Iono — ok');
  assert.deepEqual(out.cards, []);
});

test('Poko is told how to tag the cards it names', () => {
  assert.match(REPLY_CARDS_DIRECTIVE, /\[\[cards:/);
});

test('appendTurn stamps the question before the answer and links them', async () => {
  const writes = [];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (String(request).includes('_firebase')) {
      const firestoreFn = () => ({});
      firestoreFn.FieldValue = { serverTimestamp: () => 'TS' };
      firestoreFn.Timestamp = { fromMillis: (ms) => ({ ms }) };
      return { getFirebaseAdmin: () => ({ firestore: firestoreFn }) };
    }
    return originalLoad(request, parent, isMain);
  };
  const target = path.resolve(__dirname, 'poko-chat.js');
  delete require.cache[target];
  try {
    const { appendTurn, cleanClientTurnId } = require(target)._test;
    let n = 0;
    const firestore = {
      collection: () => ({
        doc: () => ({ collection: () => ({ doc: () => ({ id: `evt${(n += 1)}` }) }) }),
      }),
      batch: () => ({
        set(ref, data) { writes.push({ ref, data }); return this; },
        async commit() {},
      }),
    };
    // Same millisecond in and out: the answer must still land strictly after.
    const events = await appendTurn({
      firestore,
      uid: 'u1',
      userText: 'carte simili con piu trainers',
      cards: [],
      images: [],
      reply: 'Jessie & James…',
      replyCards: [{ cardId: '242670', cardName: 'Jessie & James' }],
      source: 'hermes',
      userAtMs: 1000,
      replyAtMs: 1000,
      clientTurnId: cleanClientTurnId('local-1-abc'),
    });
    const [user, assistant] = writes.slice(1).map((w) => w.data);
    assert.equal(user.createdAt.ms, 1000);
    assert.equal(assistant.createdAt.ms, 1001);
    assert.equal(user.turnId, assistant.turnId);
    assert.equal(user.clientTurnId, 'local-1-abc');
    assert.deepEqual(assistant.cards.map((c) => c.cardId), ['242670']);
    assert.deepEqual(events.map((e) => e.role), ['user', 'assistant']);
    assert.ok(Date.parse(events[0].createdAt) < Date.parse(events[1].createdAt));
    assert.equal(cleanClientTurnId('bad id!'), '');
  } finally {
    Module._load = originalLoad;
    delete require.cache[target];
  }
});
