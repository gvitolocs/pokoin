import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionsStore } from './portfolio-collections-store.js';

const DAY = '2026-11-17';

function answer(collections, days) {
  return {
    priceBasis: 'ct-last-sold',
    limits: { collections: 3, items: 300, quantity: 999, name: 40 },
    collections,
    segmentDefs: collections.map((row) => ({ key: `collection:${row.id}`, group: 'collection', label: row.name })),
    days: days || [{ date: DAY, segments: Object.fromEntries(collections.map((row) => [
      `collection:${row.id}`,
      [row.items.reduce((acc, item) => acc + (item.pricePkn || 0) * item.quantity, 0), row.items.length, row.items.length],
    ])) }],
  };
}

/** One card line of a draft, with the facets the server reads the slice by. */
function item(cardId = '129552') {
  return { game: 'pokemon', cardId, condition: 'NM', language: 'EN', quantity: 1, name: 'Charizard' };
}

/**
 * What the desk gets while the price service is out: the seller's own lists
 * with every price nulled, not one day, and the field that says why.
 */
function pricesOut(collections) {
  const out = answer(collections.map((row) => ({
    ...row,
    items: row.items.map((card) => ({ ...card, pricePkn: null })),
  })), []);
  return { ...out, seriesError: 'prices_unavailable' };
}

function binder(items = [{ game: 'pokemon', cardId: '129552', condition: 'NM', language: 'EN', quantity: 1, name: 'Charizard', pricePkn: 480 }]) {
  return { id: 'c1', name: 'Charizard binder', items };
}

/** The three calls with what they were asked for, so a test can count them. */
function engine({ read, save, drop, bearer = () => 't' } = {}) {
  const calls = { read: 0, save: [], drop: [], bearer: 0 };
  const store = createCollectionsStore({
    bearer: () => {
      calls.bearer += 1;
      return bearer();
    },
    fetchCollections: () => {
      calls.read += 1;
      return read();
    },
    saveCollection: (token, body) => {
      calls.save.push({ token, body });
      return save(body);
    },
    deleteCollection: (token, id) => {
      calls.drop.push({ token, id });
      return drop(id);
    },
  });
  return { store, calls };
}

function err(status, code) {
  const error = new Error(code || `http ${status}`);
  error.status = status;
  error.body = code ? { code } : null;
  return error;
}

/** A request goes out on a later task; a test that paces them has to let it. */
const tick = () => new Promise((done) => setTimeout(done, 0));

test('the level waits for its own seller', async () => {
  const { store, calls } = engine({ read: () => Promise.resolve(answer([binder()])) });
  assert.equal(store.model(), null, 'nothing asked, nothing to table');
  await store.load('u1');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.ok(store.model(), 'answered: the level exists');
  assert.deepEqual(store.get().limits, { collections: 3, items: 300, quantity: 999, name: 40 });
  assert.equal(calls.read, 1);
  // The same seller again is a refresh of what is on screen, not a blank.
  await store.load('u1');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.equal(calls.read, 2);
  // Another uid never inherits the first one's lists, not even for a moment.
  const switching = store.load('u2');
  assert.deepEqual(store.get().collections, [], 'the previous seller’s lists go first');
  assert.equal(store.model(), null);
  assert.equal(store.get().pending, true);
  await switching;
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.equal(store.get().uid, 'u2');
  // Signing out drops the state and asks nothing.
  await store.load('');
  assert.deepEqual(store.get().collections, []);
  assert.equal(store.model(), null);
  assert.equal(store.get().pending, false);
  assert.equal(calls.read, 3);
});

test('an answer that arrives after the seller changed never lands', async () => {
  const late = [];
  const { store, calls } = engine({
    read: () => new Promise((resolve) => {
      late.push(resolve);
    }),
  });
  // u1’s read stays in flight; u2 arrives and answers while it is out.
  const first = store.load('u1');
  assert.equal(store.get().pending, true);
  await tick();
  assert.equal(late.length, 1, 'one read for one seller');
  const second = store.load('u2');
  assert.deepEqual(store.get().collections, [], 'the previous seller’s lists go first');
  assert.equal(store.get().uid, 'u2', 'and the new one is who the store is asking for');
  assert.equal(store.model(), null, 'nothing of theirs is on screen yet');
  await tick();
  assert.equal(late.length, 2);
  late[1](answer([{ id: 'mine', name: 'This seller', items: [] }]));
  await second;
  assert.deepEqual(store.get().collections.map((row) => row.name), ['This seller']);
  assert.equal(store.get().uid, 'u2');
  // Now u1’s retry answers: it belongs to someone who is no longer here.
  late[0](answer([{ id: 'stale', name: 'Too late', items: [] }]));
  await first;
  assert.deepEqual(store.get().collections.map((row) => row.name), ['This seller'], 'its answer is dropped with its run');
  assert.equal(store.get().pending, false, 'and it does not clear the flag either way');
  assert.equal(calls.read, 2);
});

test('a failed load leaves the level its line and a retry', async () => {
  let fail = true;
  const { store, calls } = engine({
    read: () => (fail ? Promise.reject(err(401, '')) : Promise.resolve(answer([binder()]))),
  });
  await store.load('u1');
  assert.equal(store.get().error, 'Sign in again to save your collections.');
  assert.ok(store.model(), 'the level is there to say it failed');
  assert.deepEqual(store.get().collections, []);
  assert.equal(store.get().pending, false);
  fail = false;
  await store.reload();
  assert.equal(store.get().error, '');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.equal(calls.read, 2);
});

test('a retry keeps the level on screen while it is out', async () => {
  let fail = true;
  let release = null;
  const { store } = engine({
    read: () => (fail ? Promise.reject(err(500, '')) : new Promise((resolve) => {
      release = resolve;
    })),
  });
  await store.load('u1');
  assert.ok(store.model(), 'the failure is a level with a line in it');
  fail = false;
  const retrying = store.reload();
  // Clearing the stale sentence must not clear the level it was drawn on.
  assert.ok(store.model(), 'the level does not blink out for the duration of the retry');
  assert.equal(store.get().error, '', 'the old line is gone while the desk works');
  assert.equal(store.get().pending, true);
  await tick();
  release(answer([binder()]));
  await retrying;
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.equal(store.get().pending, false);
  assert.ok(store.model());
});

test('the answer that prices nothing is a level with its counts, not a failed load', async () => {
  const list = {
    id: 'c1',
    name: 'Charizard binder',
    items: [
      { ...item(), pricePkn: null },
      { ...item('13'), quantity: 3, pricePkn: null },
    ],
  };
  const { store, calls } = engine({
    read: () => Promise.resolve(pricesOut([list])),
    save: () => Promise.resolve(pricesOut([{ ...list, name: 'Binder' }])),
    drop: () => Promise.resolve(pricesOut([])),
  });
  const state = await store.load('u1');
  assert.equal(calls.read, 1);
  assert.equal(state.error, '', 'nothing failed: the seller is who they are and the lists came back');
  assert.equal(state.settled, true);
  assert.equal(state.pricesUnavailable, true);
  assert.equal(store.pricesUnavailable(), true);
  assert.deepEqual(state.levelModel.days, [], 'the graph has nothing to plot');
  assert.deepEqual(
    state.levelModel.defs.map((def) => [def.key, def.label, def.held]),
    [['collection:c1', 'Charizard binder', 4]],
    'and the list counts its own cards, since no day can do it',
  );
  assert.equal(state.collections[0].items.length, 2, 'every card of the list is still there to edit');
  // A write whose answer is the same shape says the same thing: the desk does
  // not start promising numbers it does not have.
  const saved = await store.save({ id: 'c1', name: 'Binder', items: store.get().collections[0].items });
  assert.equal(saved.ok, true);
  assert.equal(store.get().error, '');
  assert.equal(store.get().pricesUnavailable, true);
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Binder']);
  // Deleting the last list ends the level's prices as it ends its rows.
  await store.remove('c1');
  assert.equal(store.get().pricesUnavailable, true);
  assert.deepEqual(store.get().collections, []);
});

test('a day-less answer is not, by itself, the prices being out', async () => {
  const { store } = engine({ read: () => Promise.resolve(answer([binder()], [])) });
  await store.load('u1');
  // Only the field says the service is out. An answer that happens to carry no
  // day — a seller whose cards have never sold — leaves the prices the rows do
  // have, and the rows say what they said before.
  assert.equal(store.get().pricesUnavailable, false);
  assert.equal(store.get().collections[0].items[0].pricePkn, 480);
});

test('a load that failed is a sentence, and leaves the prices it did not touch', async () => {
  let fail = false;
  const { store } = engine({
    read: () => (fail ? Promise.reject(err(500, '')) : Promise.resolve(answer([binder()]))),
  });
  await store.load('u1');
  fail = true;
  await store.reload();
  assert.equal(store.get().error, 'Could not load your collections.');
  assert.equal(store.get().pricesUnavailable, false, 'the desk does not claim the service is out');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder'], 'the lists it was given stay');
  assert.equal(store.get().collections[0].items[0].pricePkn, 480, 'and so do their prices');
});

test('a save answer is the state: no second read after a write', async () => {
  const saved = answer([binder([{ game: 'pokemon', cardId: '129552', condition: 'NM', language: 'EN', quantity: 2, name: 'Charizard', pricePkn: 480 }])]);
  const { store, calls } = engine({
    read: () => Promise.resolve(answer([binder()])),
    save: () => Promise.resolve({ ...saved, saved: 'c1' }),
    drop: () => Promise.resolve(answer([])),
  });
  await store.load('u1');
  assert.equal(calls.read, 1);
  const result = await store.save({ id: 'c1', name: 'Charizard binder', items: saved.collections[0].items });
  assert.deepEqual(result, { ok: true, saved: 'c1' });
  assert.equal(calls.read, 1, 'the POST answer carries the lists and the days');
  assert.equal(store.get().collections[0].items[0].quantity, 2);
  // What goes on the wire is the draft with the item identity and the price left
  // at home: the server resolves prices, so none is claimed here.
  assert.deepEqual(calls.save[0], {
    token: 't',
    body: {
      id: 'c1',
      name: 'Charizard binder',
      items: [{
        game: 'pokemon',
        cardId: '129552',
        condition: 'NM',
        language: 'EN',
        reverse: false,
        firstEdition: false,
        graded: false,
        quantity: 2,
        name: 'Charizard',
        setName: '',
      }],
    },
  });
  // Delete takes the answer the same way.
  const gone = await store.remove('c1');
  assert.deepEqual(gone, { ok: true, saved: '' });
  assert.deepEqual(store.get().collections, []);
  assert.deepEqual(calls.drop, [{ token: 't', id: 'c1' }]);
  assert.equal(calls.read, 1);
  assert.ok(store.model(), 'an empty list of collections is still the level');
  assert.deepEqual(store.model().defs, []);
});

test('a draft that cannot be saved never reaches the server', async () => {
  const { store, calls } = engine({
    read: () => Promise.resolve(answer([binder()])),
    save: () => Promise.reject(new Error('must not be asked')),
  });
  await store.load('u1');
  assert.deepEqual(store.validate({ name: '', items: [{ cardId: '1', id: 'x', quantity: 1 }] }), ['A collection needs a name.']);
  assert.deepEqual(store.validate({ name: 'Charizard binder', items: [{ cardId: '1', id: 'x', quantity: 1 }] }), ['You already have a collection with that name.']);
  assert.deepEqual(store.validate({ id: 'c1', name: 'Charizard binder', items: [{ cardId: '1', id: 'x', quantity: 1 }] }), [], 'renaming it to itself is not taken');
  const problems = await store.save({ name: '', items: [] });
  assert.equal(problems.ok, false);
  assert.match(problems.message, /needs a name/i);
  assert.equal(calls.save.length, 0, 'a draft that fails the checks is never sent');
  // A request that throws for a reason of its own still comes back as a
  // sentence, and the lists on screen are untouched.
  const thrown = await store.save({
    name: 'New',
    items: [{ game: 'pokemon', cardId: '1', condition: 'NM', language: 'EN', quantity: 1 }],
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.message, 'Could not save the collection.');
  assert.equal(calls.save.length, 1, 'a draft that passes the checks is sent');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.equal(store.get().saving, '');
});

test('a rejected write says why and keeps the lists on screen', async () => {
  const { store } = engine({
    read: () => Promise.resolve(answer([binder()])),
    save: () => Promise.reject(err(409, 'collection_name_taken')),
    drop: () => Promise.reject(err(404, 'collection_not_found')),
  });
  await store.load('u1');
  const result = await store.save({ name: 'Sealed', items: [{ cardId: '1', id: 'x', quantity: 1, game: 'pokemon', condition: 'NM', language: 'EN' }] });
  assert.equal(result.ok, false);
  assert.equal(result.message, 'You already have a collection with that name.');
  assert.equal(store.get().saving, '');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder'], 'nothing changed');
  const gone = await store.remove('c9');
  assert.equal(gone.ok, false);
  assert.equal(gone.message, 'That collection is not there any more.');
  assert.equal((await store.remove('')).message, 'Which collection should go?', 'an empty id is refused before the request');
});

test('the limit closes the door before the request', async () => {
  const many = [1, 2, 3].map((n) => ({ id: `c${n}`, name: `List ${n}`, items: [] }));
  const { store } = engine({ read: () => Promise.resolve(answer(many)) });
  await store.load('u1');
  assert.equal(store.atLimit(), true);
  assert.deepEqual(
    store.validate({ name: 'One more', items: [{ cardId: '1', id: 'x', quantity: 1 }] }),
    ['You can keep up to 3 collections.'],
  );
});

test('the fixture store writes memory and asks nothing', async () => {
  const calls = { read: 0, save: 0, drop: 0 };
  const store = createCollectionsStore({
    bearer: () => 't',
    fetchCollections: () => {
      calls.read += 1;
      return Promise.reject(new Error('the preview asks nothing'));
    },
    saveCollection: () => {
      calls.save += 1;
      return Promise.reject(new Error('the preview asks nothing'));
    },
    deleteCollection: () => {
      calls.drop += 1;
      return Promise.reject(new Error('the preview asks nothing'));
    },
    // The layout seeds itself on the first ask; what the desk adds afterwards
    // is what it is told to answer with, so a saved list survives the next draw.
    previewAnswer: (collections) => answer(collections.length ? collections : [binder()]),
  });
  await store.load('');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  assert.ok(store.model());
  assert.equal(calls.read, 0);
  const saved = await store.save({
    name: 'Sealed',
    items: [{ game: 'pokemon', cardId: '7', condition: 'NM', language: 'EN', quantity: 2 }],
  });
  assert.equal(saved.ok, true);
  assert.match(saved.saved, /^preview-/);
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder', 'Sealed']);
  assert.deepEqual(store.model().defs.map((def) => def.label), ['Charizard binder', 'Sealed']);
  assert.equal(calls.save, 0);
  const again = await store.save({ id: saved.saved, name: 'Sealed 2023', items: [{ game: 'pokemon', cardId: '7', condition: 'NM', language: 'EN', quantity: 2 }] });
  assert.equal(again.saved, saved.saved, 'editing the memory list keeps its id');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder', 'Sealed 2023']);
  await store.remove('c1');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Sealed 2023']);
  assert.equal(calls.drop, 0);
});

test('a write whose seller left before the token is in hand is never sent', async () => {
  let token = 't';
  let releaseToken = null;
  const { store, calls } = engine({
    read: () => Promise.resolve(answer([binder()])),
    bearer: () => token,
    save: () => Promise.resolve(answer([])),
    drop: () => Promise.resolve(answer([])),
  });
  await store.load('u1');
  // The token now takes its time, and the seller goes while it is out.
  token = new Promise((resolve) => {
    releaseToken = resolve;
  });
  const saving = store.save({ id: 'c1', name: 'Theirs', items: [item()] });
  const dropping = store.remove('c1');
  await tick();
  assert.equal(store.get().saving, 'c1', 'both writes think they are still on');
  await store.load('');
  releaseToken('t');
  assert.deepEqual(await saving, { ok: false, message: 'Could not save the collection.' });
  assert.deepEqual(await dropping, { ok: false, message: 'Could not delete the collection.' });
  assert.equal(calls.save.length, 0, 'the POST was never made');
  assert.equal(calls.drop.length, 0, 'nor the DELETE');
  assert.deepEqual(store.get().collections, [], 'and nothing of the previous seller came back');
  assert.equal(store.get().saving, '', 'the sign-out cleared the flag it was holding');
});

test('a write answering after the seller changed never lands on the new one', async () => {
  const posts = [];
  const reads = [];
  const { store, calls } = engine({
    read: () => new Promise((resolve) => {
      reads.push(resolve);
    }),
    save: () => new Promise((resolve) => {
      posts.push(resolve);
    }),
    drop: () => new Promise((resolve) => {
      posts.push(resolve);
    }),
  });
  const first = store.load('u1');
  await tick();
  reads[0](answer([binder()]));
  await first;
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);

  const saving = store.save({ id: 'c1', name: 'Theirs', items: [item()] });
  await tick();
  assert.equal(posts.length, 1, 'the write did go out for the seller who asked');

  // The seller switches while the POST is out, and their own lists answer.
  const second = store.load('u2');
  await tick();
  reads[1](answer([{ id: 'z9', name: 'Mine', items: [] }]));
  await second;
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Mine']);

  // u1’s answer arrives: it is the previous desk's business now.
  posts[0](answer([{ id: 'c1', name: 'Theirs', items: [item()] }]));
  assert.deepEqual(await saving, { ok: false, message: 'Could not save the collection.' });
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Mine'], 'the new seller’s state is untouched');
  assert.equal(store.get().uid, 'u2');
  assert.ok(store.model(), "and their level is still only their own lists");

  // A sign-out with a delete out does the same: no answer, no lists.
  const dropping = store.remove('z9');
  await tick();
  assert.equal(posts.length, 2);
  await store.load('');
  posts[1](answer([]));
  assert.deepEqual(await dropping, { ok: false, message: 'Could not delete the collection.' });
  assert.deepEqual(store.get().collections, []);
  assert.equal(store.model(), null, 'nobody is here to have a level');
  assert.equal(calls.read, 2, 'the sign-out asked for nothing of its own');
});

test('the fixture seeds itself once and then answers what the desk holds', async () => {
  const asked = [];
  const store = createCollectionsStore({
    bearer: () => 't',
    fetchCollections: () => Promise.reject(new Error('the preview asks nothing')),
    saveCollection: () => Promise.reject(new Error('the preview asks nothing')),
    deleteCollection: () => Promise.reject(new Error('the preview asks nothing')),
    previewAnswer: (rows, seeding) => {
      asked.push({ held: rows.length, seeding: Boolean(seeding) });
      return answer(seeding ? [binder()] : rows);
    },
  });
  await store.load('preview');
  assert.deepEqual(asked.at(-1), { held: 0, seeding: true }, 'the empty desk is the layout being laid out');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Charizard binder']);
  // Deleting the last list is an answer of its own: empty, and it stays empty.
  await store.remove('c1');
  assert.deepEqual(store.get().collections, []);
  assert.ok(store.model(), 'the empty level is still the level');
  await store.load('preview');
  assert.deepEqual(asked.at(-1), { held: 0, seeding: false }, 'nothing is seeding any more');
  assert.deepEqual(store.get().collections, [], 'and the deleted lists do not come back');
});

test('a preview list is never given an id that was already used', async () => {
  const store = createCollectionsStore({
    bearer: () => 't',
    fetchCollections: () => Promise.reject(new Error('the preview asks nothing')),
    saveCollection: () => Promise.reject(new Error('the preview asks nothing')),
    deleteCollection: () => Promise.reject(new Error('the preview asks nothing')),
    previewAnswer: (collections) => answer(collections),
  });
  await store.load('preview');
  const first = await store.save({ name: 'One', items: [item()] });
  assert.equal(first.saved, 'preview-1');
  await store.remove(first.saved);
  const second = await store.save({ name: 'Two', items: [item()] });
  // An id handed to a deleted list must not come back: the desk keys its open
  // row and its editor on it, and a row that reappears under an old id is a row
  // the seller deleted.
  assert.equal(second.saved, 'preview-2', 'the counter only grows');
  assert.deepEqual(store.get().collections.map((row) => row.name), ['Two']);
});

test('a save whose answer does not carry the list is refused, not reported done', async () => {
  const { store } = engine({
    read: () => Promise.resolve(answer([binder()])),
    save: () => Promise.resolve({ ...answer([binder()]), saved: 'c9' }),
  });
  await store.load('u1');
  assert.deepEqual(await store.save({ id: 'c1', name: 'Charizard binder', items: [item()] }), {
    ok: false,
    message: 'The saved collection did not come back. Try again.',
  }, 'an answer naming a list it does not contain saved nothing');
  assert.equal(store.get().saving, '');
  const blank = engine({
    read: () => Promise.resolve(answer([])),
    save: () => Promise.resolve(answer([])),
  });
  await blank.store.load('u1');
  const fresh = await blank.store.save({ name: 'Sealed', items: [item()] });
  assert.equal(fresh.ok, false, 'a new list missing from its own answer is the same refusal');
  assert.equal(blank.store.get().collections.length, 0);
});

test('subscribers follow every change and stop when they let go', async () => {
  const { store } = engine({
    read: () => Promise.resolve(answer([binder()])),
    drop: () => Promise.resolve(answer([])),
  });
  const seen = [];
  const stop = store.subscribe((state) => seen.push({
    held: state.collections.length,
    pending: state.pending,
    saving: state.saving,
  }));
  await store.load('u1');
  assert.deepEqual(seen, [
    { held: 0, pending: true, saving: '' },
    { held: 1, pending: false, saving: '' },
  ], 'out for the request, then the answer');
  seen.length = 0;
  await store.remove('c1');
  assert.deepEqual(seen, [
    { held: 1, pending: false, saving: 'c1' },
    { held: 0, pending: false, saving: '' },
  ], 'the write sets its flag, the answer clears it with the lists');
  seen.length = 0;
  stop();
  await store.load('u1');
  assert.equal(seen.length, 0, 'unsubscribed');
});
