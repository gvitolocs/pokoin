import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUGGEST_ROTATE_DEFAULT,
  SUGGEST_ROTATE_HEAD,
  SUGGEST_ROTATE_POOL,
  nextRotateState,
  rotateTail,
  suggestRotateEnabled,
} from './suggest-rotate.js';

function ranked(count) {
  return Array.from({ length: count }, (_, rank) => ({ id: `c${rank}`, rank }));
}

function ranks(rows) {
  return rows.map((row) => row.rank);
}

function assertRankOrder(rows) {
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(rows[index].rank > rows[index - 1].rank, `rank ${rows[index].rank} follows ${rows[index - 1].rank}`);
  }
}

test('rotation is off unless storage says so', () => {
  assert.equal(SUGGEST_ROTATE_HEAD, 5);
  assert.equal(SUGGEST_ROTATE_POOL, 50);
  assert.equal(SUGGEST_ROTATE_DEFAULT, false);
  const prev = globalThis.localStorage;
  try {
    delete globalThis.localStorage;
    assert.equal(suggestRotateEnabled(), false);
    globalThis.localStorage = { getItem: () => '1' };
    assert.equal(suggestRotateEnabled(), true);
    globalThis.localStorage = { getItem: () => '0' };
    assert.equal(suggestRotateEnabled(), false);
    globalThis.localStorage = { getItem: () => 'yes' };
    assert.equal(suggestRotateEnabled(), false);
    globalThis.localStorage = { getItem: () => { throw new Error('denied'); } };
    assert.equal(suggestRotateEnabled(), false);
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
});

test('step 0 is the ordinary prefix, including a short pool', () => {
  const rows = ranked(50);
  assert.deepEqual(ranks(rotateTail(rows, { step: 0 })), ranks(rows.slice(0, 20)));
  assert.deepEqual(ranks(rotateTail(rows)), ranks(rows.slice(0, 20)));
  const short = ranked(12);
  assert.deepEqual(ranks(rotateTail(short, { step: 4 })), ranks(short));
  assert.deepEqual(rotateTail(undefined, { step: 2 }), []);
});

test('the head stays the top five and every page stays in rank order', () => {
  const rows = ranked(SUGGEST_ROTATE_POOL);
  const seen = new Set();
  let step = 1;
  let guard = 0;
  let first = null;
  while (guard < 8) {
    const shown = rotateTail(rows, { step });
    assert.equal(shown.length, 20);
    assert.deepEqual(ranks(shown).slice(0, 5), [0, 1, 2, 3, 4]);
    assertRankOrder(shown);
    const key = ranks(shown).join(',');
    if (first === null) first = key;
    else if (key === first) break;
    seen.add(key);
    step += 1;
    guard += 1;
  }
  // 45 tail rows, 15 slots → 3 pages, then step wraps to the first page.
  assert.equal(seen.size, 3);
  assert.equal(step, 4);
  assert.deepEqual(ranks(rotateTail(rows, { step: 3 })), ranks(rotateTail(rows, { step: 0 })));
});

test('a short last page fills from the highest-ranked tail rows', () => {
  // Tail is 20 long (ranks 5..24), 15 slots → page 1 holds ranks 20..24
  // and fills with ranks 5..14, then sorts back into rank order.
  const shown = rotateTail(ranked(25), { step: 1 });
  assert.deepEqual(ranks(shown), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24]);
  assertRankOrder(shown);
  assert.deepEqual(ranks(shown).slice(0, 5), [0, 1, 2, 3, 4]);
});

test('nextRotateState keeps a step on the same term and advances only a stable head', () => {
  const head = 'a|b|c|d|e';
  let state = nextRotateState(null, { term: 'pika', headKey: head });
  assert.deepEqual(state, { term: 'pika', headKey: head, step: 0 });

  state = nextRotateState(state, { term: 'pika', headKey: 'a|b|c|d|x' });
  assert.equal(state.step, 0);
  assert.equal(state.headKey, 'a|b|c|d|x');

  state = nextRotateState(state, { term: 'pikachu', headKey: 'a|b|c|d|x' });
  assert.equal(state.step, 1);

  state = nextRotateState(state, { term: '  PIKACHU v', headKey: 'a|b|c|d|x' });
  assert.equal(state.step, 2);

  state = nextRotateState(state, { term: 'pikachu vmax', headKey: 'a|b|c|d|z' });
  assert.equal(state.step, 0);

  state = nextRotateState({ term: 'pikachu', headKey: head, step: 3 }, { term: 'pika', headKey: head });
  assert.equal(state.step, 0);

  state = nextRotateState({ term: 'pi', headKey: '', step: 2 }, { term: 'pik', headKey: '' });
  assert.equal(state.step, 0);

  state = nextRotateState({ term: 'char', headKey: head, step: 4 }, { term: 'pika', headKey: head });
  assert.equal(state.step, 0);
});
