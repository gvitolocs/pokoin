import assert from 'node:assert/strict';
import test from 'node:test';
import { nextRailScrollLeft, railAtEnd, railAtStart } from './rail-scroll.js';

test('back at the start stays put', () => {
  const node = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 0 };
  assert.equal(nextRailScrollLeft(node, -1), 0);
});

test('next at the end stays put', () => {
  const node = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 2000 };
  assert.equal(nextRailScrollLeft(node, 1), 2000);
});

test('next from the start pages forward', () => {
  const node = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 0 };
  assert.equal(nextRailScrollLeft(node, 1), 800);
});

test('prev from the middle pages back', () => {
  const node = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 800 };
  assert.equal(nextRailScrollLeft(node, -1), 0);
});

test('railAtStart and railAtEnd follow the scroll edges', () => {
  const start = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 0 };
  const middle = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 800 };
  const end = { clientWidth: 1000, scrollWidth: 3000, scrollLeft: 2000 };
  const fits = { clientWidth: 1000, scrollWidth: 900, scrollLeft: 0 };
  assert.equal(railAtStart(start), true);
  assert.equal(railAtEnd(start), false);
  assert.equal(railAtStart(middle), false);
  assert.equal(railAtEnd(middle), false);
  assert.equal(railAtStart(end), false);
  assert.equal(railAtEnd(end), true);
  assert.equal(railAtStart(fits), true);
  assert.equal(railAtEnd(fits), true);
});
