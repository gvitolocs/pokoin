import test from 'node:test';
import assert from 'node:assert/strict';
import { SUGGEST_REPAINT_MS, createRepaintGate } from './suggest-repaint.js';

function fakeScheduler() {
  const pending = [];
  let nextId = 1;
  return {
    pending,
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.push({ id, fn, ms });
      return id;
    },
    cancel(id) {
      const index = pending.findIndex((timer) => timer.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

function gateWith(clock) {
  const bumps = [];
  const gate = createRepaintGate({
    delay: SUGGEST_REPAINT_MS,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bump: () => bumps.push(bumps.length + 1),
  });
  return { gate, bumps };
}

test('the first page bumps immediately', () => {
  assert.equal(SUGGEST_REPAINT_MS, 300);
  const clock = fakeScheduler();
  const { gate, bumps } = gateWith(clock);
  gate.page();
  assert.deepEqual(bumps, [1]);
  assert.equal(clock.pending.length, 0);
});

test('five pages inside the window produce one trailing bump', () => {
  const clock = fakeScheduler();
  const { gate, bumps } = gateWith(clock);
  for (let page = 0; page < 5; page += 1) gate.page();
  assert.deepEqual(bumps, [1]);
  assert.equal(clock.pending.length, 1);
  assert.equal(clock.pending[0].ms, SUGGEST_REPAINT_MS);
  clock.pending[0].fn();
  assert.deepEqual(bumps, [1, 2]);
  assert.equal(clock.pending.length, 1);
  clock.pending.shift();
  gate.page();
  assert.deepEqual(bumps, [1, 2]);
  assert.equal(clock.pending.length, 1);
});

test('flush bumps only when a page is still unpainted', () => {
  const clock = fakeScheduler();
  const { gate, bumps } = gateWith(clock);
  gate.flush();
  assert.deepEqual(bumps, []);

  gate.page();
  gate.flush();
  assert.deepEqual(bumps, [1]);

  gate.page();
  gate.page();
  assert.equal(clock.pending.length, 1);
  gate.flush();
  assert.deepEqual(bumps, [1, 2]);
  assert.equal(clock.pending.length, 0);
  gate.flush();
  assert.deepEqual(bumps, [1, 2]);
});

test('dispose cancels the pending timer', () => {
  const clock = fakeScheduler();
  const { gate, bumps } = gateWith(clock);
  gate.page();
  gate.page();
  const waiting = clock.pending[0];
  gate.dispose();
  assert.equal(clock.pending.length, 0);
  waiting.fn();
  assert.deepEqual(bumps, [1]);
});
