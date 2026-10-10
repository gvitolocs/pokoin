import test from 'node:test';
import assert from 'node:assert/strict';
import { withGroupKeys } from './suggest-group-keys.js';
import { createSuggestFlip, rowMotion } from './suggest-flip.js';

test('group keys follow the name, not the first printing', () => {
  const before = withGroupKeys([{ name: 'Dialga', printings: [{ id: '1' }, { id: '2' }] }]);
  const after = withGroupKeys([{ name: 'Dialga', printings: [{ id: '2' }, { id: '1' }] }]);
  assert.equal(before[0].key, 'Dialga');
  assert.equal(after[0].key, before[0].key);
  assert.deepEqual(after[0].printings, [{ id: '2' }, { id: '1' }]);
});

test('a repeated group name gets its own key', () => {
  const keys = withGroupKeys([{ name: 'Dialga' }, { name: 'Dialga EX' }, { name: 'Dialga' }]).map((g) => g.key);
  assert.deepEqual(keys, ['Dialga', 'Dialga EX', 'Dialga#2']);
  assert.deepEqual(withGroupKeys(undefined), []);
});

test('only rows that move up slide', () => {
  assert.equal(rowMotion(120, 40), 80);
  assert.equal(rowMotion(40, 120), null);
  assert.equal(rowMotion(40, 40.4), null);
  assert.equal(rowMotion(undefined, 40), null);
});

function fakeRow(id, top) {
  const animations = [];
  const node = {
    top,
    style: {},
    animations,
    getAttribute: (name) => (name === 'data-suggest-id' ? id : null),
    getBoundingClientRect: () => ({ top: node.top }),
    getAnimations: () => animations.filter((a) => !a.cancelled),
    animate(keyframes) {
      const animation = { keyframes, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
      animations.push(animation);
      return animation;
    },
  };
  return node;
}

function fakeList(rows) {
  return { querySelectorAll: () => rows };
}

test('same results repaint nothing; a rising row slides, the others do not', () => {
  const a = fakeRow('a', 0);
  const b = fakeRow('b', 50);
  const c = fakeRow('c', 100);
  const flip = createSuggestFlip();
  flip.update(fakeList([a, b, c]));
  flip.dispose();
  // Same order after a keystroke: no motion at all.
  flip.update(fakeList([a, b, c]));
  assert.equal(a.animations.length + b.animations.length + c.animations.length, 0);
  // c ranks first: it slides up 100 px, a and b drop without moving.
  c.top = 0;
  a.top = 50;
  b.top = 100;
  flip.update(fakeList([c, a, b]));
  assert.equal(c.animations.length, 1);
  assert.deepEqual(c.animations[0].keyframes[0], { transform: 'translateY(100px)' });
  assert.equal(c.style.zIndex, '1');
  assert.equal(a.animations.length + b.animations.length, 0);
  // A new row appears in place.
  const d = fakeRow('d', 150);
  flip.update(fakeList([c, a, b, d]));
  assert.equal(d.animations.length, 0);
});
