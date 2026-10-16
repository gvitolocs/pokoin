import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAG_LONG_PRESS_MS,
  DRAG_MOVE_THRESHOLD_PX,
  dragDistance,
  dropTarget,
  gestureShouldLift,
  hitTestZone,
  initialDrag,
  passedMoveThreshold,
  reduceDragMove,
} from './drag-move.js';

const down = {
  type: 'down',
  pointerId: 1,
  pointerType: 'mouse',
  x: 10,
  y: 20,
  now: 1000,
  from: 'held',
  payload: { id: 'h1' },
};

test('threshold is about six pixels and a touch long-press is 250ms', () => {
  assert.equal(DRAG_MOVE_THRESHOLD_PX, 6);
  assert.equal(DRAG_LONG_PRESS_MS, 250);
  assert.equal(passedMoveThreshold({ x: 0, y: 0 }, { x: 5, y: 0 }), false);
  assert.equal(passedMoveThreshold({ x: 0, y: 0 }, { x: 6, y: 0 }), true);
  assert.equal(dragDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('hit testing returns the column under the point and null outside', () => {
  const zones = [
    { id: 'held', left: 0, top: 0, right: 100, bottom: 80 },
    { id: 'listed', left: 120, top: 0, right: 220, bottom: 80 },
  ];
  assert.equal(hitTestZone(zones, 10, 10), 'held');
  assert.equal(hitTestZone(zones, 200, 40), 'listed');
  assert.equal(hitTestZone(zones, 110, 10), null);
  assert.equal(hitTestZone(zones, 100, 80), 'held');
  assert.equal(hitTestZone(null, 0, 0), null);
});

test('overlapping zones let the later column win', () => {
  const zones = [
    { id: 'pick', left: 0, top: 0, right: 50, bottom: 50 },
    { id: 'picked', left: 40, top: 40, right: 90, bottom: 90 },
  ];
  assert.equal(hitTestZone(zones, 45, 45), 'picked');
});

test('a drop only counts on the other column', () => {
  assert.equal(dropTarget('held', 'listed'), 'listed');
  assert.equal(dropTarget('listed', 'held'), 'held');
  assert.equal(dropTarget('held', 'held'), null);
  assert.equal(dropTarget('held', null), null);
  assert.equal(dropTarget(null, 'listed'), null);
});

test('pointer down arms a drag and a short move does not lift it', () => {
  const armed = reduceDragMove(initialDrag(), down);
  assert.equal(armed.action.type, 'capture');
  assert.equal(armed.state.phase, 'pending');
  assert.equal(armed.state.from, 'held');
  assert.equal(armed.state.payload.id, 'h1');
  const nudged = reduceDragMove(armed.state, {
    type: 'move',
    pointerId: 1,
    x: 14,
    y: 22,
    now: 1100,
    over: 'held',
  });
  assert.equal(nudged.action, null);
  assert.equal(nudged.state.phase, 'pending');
});

test('moving past the threshold lifts a mouse drag', () => {
  const armed = reduceDragMove(initialDrag(), down);
  const lifted = reduceDragMove(armed.state, {
    type: 'move',
    pointerId: 1,
    x: 10 + DRAG_MOVE_THRESHOLD_PX,
    y: 20,
    now: 1100,
    over: 'listed',
  });
  assert.equal(lifted.action.type, 'lift');
  assert.equal(lifted.state.phase, 'dragging');
  assert.equal(lifted.state.over, 'listed');
});

test('a touch long-press lifts without moving, and a mouse long-press does not', () => {
  const touch = reduceDragMove(initialDrag(), { ...down, pointerType: 'touch' });
  assert.equal(gestureShouldLift(touch.state, { x: 10, y: 20, now: 1000 + DRAG_LONG_PRESS_MS }), true);
  const held = reduceDragMove(touch.state, {
    type: 'longpress',
    pointerId: 1,
    over: 'held',
  });
  assert.equal(held.action.type, 'lift');
  assert.equal(held.state.phase, 'dragging');

  const mouse = reduceDragMove(initialDrag(), down);
  const ignored = reduceDragMove(mouse.state, { type: 'longpress', pointerId: 1 });
  assert.equal(ignored.action, null);
  assert.equal(ignored.state.phase, 'pending');
});

test('releasing over the other column moves, and outside or the same column cancels', () => {
  const armed = reduceDragMove(initialDrag(), down);
  const lifted = reduceDragMove(armed.state, {
    type: 'move',
    pointerId: 1,
    x: 40,
    y: 20,
    over: 'listed',
  });
  const moved = reduceDragMove(lifted.state, { type: 'up', pointerId: 1, over: 'listed' });
  assert.equal(moved.action.type, 'move');
  assert.equal(moved.action.from, 'held');
  assert.equal(moved.action.to, 'listed');
  assert.equal(moved.action.payload.id, 'h1');
  assert.equal(moved.state.phase, 'idle');

  const same = reduceDragMove(lifted.state, { type: 'up', pointerId: 1, over: 'held' });
  assert.equal(same.action.type, 'cancel');
  assert.equal(same.state.phase, 'idle');

  const outside = reduceDragMove(lifted.state, { type: 'up', pointerId: 1, over: null });
  assert.equal(outside.action.type, 'cancel');
});

test('escape, a different pointer, and a release before lift do not move the card', () => {
  const armed = reduceDragMove(initialDrag(), down);
  const early = reduceDragMove(armed.state, { type: 'up', pointerId: 1, over: 'listed' });
  assert.equal(early.action.type, 'cancel');
  assert.equal(early.state.payload, null);

  const again = reduceDragMove(initialDrag(), down);
  const other = reduceDragMove(again.state, { type: 'move', pointerId: 2, x: 80, y: 20, over: 'listed' });
  assert.equal(other.state.phase, 'pending');
  assert.equal(other.state.x, 10);

  const escaped = reduceDragMove(again.state, { type: 'escape', pointerId: 1 });
  assert.equal(escaped.action.type, 'cancel');
  assert.equal(escaped.state.phase, 'idle');

  const idle = reduceDragMove(initialDrag(), { type: 'escape', pointerId: 1 });
  assert.equal(idle.action, null);
});
