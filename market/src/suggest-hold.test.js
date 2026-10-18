import assert from 'node:assert/strict';
import test from 'node:test';
import { SUGGEST_SESSION_CLOSED, nextSuggestSession } from './suggest-hold.js';

const row = (id) => ({ key: id, card: { id } });
const SCOPE = 'singles|all|true';

/** Feed keystroke states through the reducer the way SearchBox's memo does. */
function play(steps) {
  let session = SUGGEST_SESSION_CLOSED;
  return steps.map((step) => {
    session = nextSuggestSession(session, { open: true, scope: SCOPE, pokemon: true, ...step });
    return session;
  });
}

test('the popup stays up and keeps its rows across a typing session with a zero-row keystroke', () => {
  const charizard = [row('1'), row('2'), row('3')];
  const states = play([
    { query: 'c', ready: false, pending: true, rows: [] },
    { query: 'ch', ready: false, pending: true, rows: [] },
    { query: 'cha', ready: true, pending: true, rows: [] },
    { query: 'char', ready: true, pending: true, rows: charizard },
    { query: 'chari', ready: true, pending: false, rows: charizard },
    // `charizar`: the next ranking has nothing yet while its lookup is in flight.
    { query: 'charizar', ready: true, pending: true, rows: [] },
    // The term still trails the input by one paint.
    { query: 'charizard', ready: true, pending: true, rows: [] },
    { query: 'charizard', ready: true, pending: false, rows: [row('2'), row('9')] },
  ]);
  assert.deepEqual(states.map((state) => state.visible), [false, false, true, true, true, true, true, true]);
  // Once the popup has opened it never hides again.
  const opened = states.findIndex((state) => state.visible);
  assert.ok(states.slice(opened).every((state) => state.visible));
  // The zero-row keystrokes keep the very same row objects (no remount, no "Searching…").
  assert.equal(states[5].rows, charizard);
  assert.equal(states[6].rows, charizard);
  assert.deepEqual(states[7].rows.map((item) => item.key), ['2', '9']);
});

test('backspacing under three letters keeps the open popup and its rows', () => {
  const tog = [row('t1'), row('t2')];
  const states = play([
    { query: 'tog', ready: true, pending: false, rows: tog },
    { query: 'to', ready: false, pending: false, rows: [] },
    { query: 'tog', ready: true, pending: false, rows: tog },
  ]);
  assert.ok(states.every((state) => state.visible));
  assert.equal(states[1].rows, tog);
});

test('a settled empty result shows "no match" inside the open popup', () => {
  const states = play([
    { query: 'pik', ready: true, pending: false, rows: [row('p')] },
    { query: 'pikzzq', ready: true, pending: true, rows: [] },
    { query: 'pikzzq', ready: true, pending: false, rows: [] },
  ]);
  assert.ok(states.every((state) => state.visible));
  assert.equal(states[1].rows.length, 1);
  assert.equal(states[2].rows.length, 0);
});

test('Escape / outside click / empty field close it; another tab never inherits held rows', () => {
  let session = nextSuggestSession(SUGGEST_SESSION_CLOSED, { open: true, query: 'mew', ready: true, rows: [row('m')], scope: SCOPE });
  assert.equal(session.visible, true);
  assert.equal(nextSuggestSession(session, { open: false, query: 'mew', ready: true, rows: [row('m')], scope: SCOPE }).visible, false);
  assert.equal(nextSuggestSession(session, { open: true, query: '  ', ready: false, rows: [], scope: SCOPE }).visible, false);
  const product = nextSuggestSession(session, { open: true, query: 'mew', ready: true, pending: true, rows: [], scope: 'product|all|true' });
  assert.equal(product.visible, true);
  assert.equal(product.rows.length, 0);
});

test('an unchanged state returns the same session object (no downstream repaint)', () => {
  const rows = [row('a')];
  const first = nextSuggestSession(SUGGEST_SESSION_CLOSED, { open: true, query: 'abra', ready: true, rows, scope: SCOPE });
  assert.equal(nextSuggestSession(first, { open: true, query: 'abra', ready: true, rows, scope: SCOPE }), first);
});
