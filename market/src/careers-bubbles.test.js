import assert from 'node:assert/strict';
import test from 'node:test';
import { DRIFT_SPEED, MAX_THROW, capThrow, driftVelocity, stepBubbles } from './careers-bubbles.js';

const body = (over = {}) => ({ x: 50, y: 50, r: 10, vx: 0, vy: 0, dragging: false, ...over });

test('free bubbles drift at cruise speed and stay inside the stage', () => {
  const b = body({ x: 15, y: 50, vx: -DRIFT_SPEED, vy: 0 });
  for (let i = 0; i < 200; i += 1) stepBubbles([b], 0.016, 100, 100);
  assert.ok(b.x - b.r >= 0 && b.x + b.r <= 100);
  assert.ok(b.y - b.r >= 0 && b.y + b.r <= 100);
  assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - DRIFT_SPEED) < 0.01);
});

test('a bubble bounces off a wall instead of leaving', () => {
  const b = body({ x: 11, vx: -50 });
  stepBubbles([b], 0.05, 100, 100);
  assert.equal(b.x, b.r);
  assert.ok(b.vx > 0);
});

test('a thrown bubble eases back to cruise speed', () => {
  const b = body({ vx: 200, vy: 0 });
  for (let i = 0; i < 300; i += 1) stepBubbles([b], 0.016, 10000, 100);
  assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - DRIFT_SPEED) < 0.5);
});

test('reduced motion: cruise 0 brings a bubble to rest', () => {
  const b = body({ vx: 40, vy: 0 });
  for (let i = 0; i < 400; i += 1) stepBubbles([b], 0.016, 10000, 100, 0);
  assert.ok(Math.hypot(b.vx, b.vy) < 0.1);
});

test('overlapping bubbles separate and exchange normal velocity', () => {
  const a = body({ x: 40, y: 50, vx: 5, vy: 0 });
  const b = body({ x: 55, y: 50, vx: -5, vy: 0 });
  stepBubbles([a, b], 0, 100, 100);
  assert.ok(b.x - a.x >= a.r + b.r - 1e-9);
  assert.ok(a.vx < 0 && b.vx > 0);
});

test('a dragged bubble holds still and pushes the other away', () => {
  const held = body({ x: 50, y: 50, dragging: true });
  const other = body({ x: 60, y: 50, vx: -5 });
  stepBubbles([held, other], 0.016, 200, 200);
  assert.equal(held.x, 50);
  assert.equal(held.y, 50);
  assert.ok(other.x - held.x >= held.r + other.r - 1e-9);
  assert.ok(other.vx > 0);
});

test('huge frames are clamped so bubbles never teleport', () => {
  const b = body({ x: 500, vx: DRIFT_SPEED });
  stepBubbles([b], 30, 10000, 100);
  assert.ok(b.x - 500 <= DRIFT_SPEED * 0.05 + 1e-9);
});

test('throws are capped and drift starts in a random direction at cruise speed', () => {
  const capped = capThrow(3000, 4000);
  assert.ok(Math.abs(Math.hypot(capped.vx, capped.vy) - MAX_THROW) < 1e-9);
  assert.deepEqual(capThrow(3, 4), { vx: 3, vy: 4 });
  const v = driftVelocity(DRIFT_SPEED, () => 0.25);
  assert.ok(Math.abs(v.vx) < 1e-9 && Math.abs(v.vy - DRIFT_SPEED) < 1e-9);
});
