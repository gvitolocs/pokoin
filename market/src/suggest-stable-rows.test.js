import test from 'node:test';
import assert from 'node:assert/strict';
import { withGroupKeys } from './suggest-group-keys.js';
import { MOVE_MS, createSuggestFlip, rowMotion } from './suggest-flip.js';

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
    animate(keyframes, options) {
      const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
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
  assert.equal(c.animations[0].options.duration, MOVE_MS);
  assert.ok(MOVE_MS >= 400, 'rising rows slide slowly enough to follow');
  assert.equal(c.style.zIndex, '1');
  assert.equal(a.animations.length + b.animations.length, 0);
  // A new row appears in place.
  const d = fakeRow('d', 150);
  flip.update(fakeList([c, a, b, d]));
  assert.equal(d.animations.length, 0);
});

/** Read `node.translateY` the way a running WAAPI transform would. */
function withTranslate(run) {
  const prevStyle = globalThis.getComputedStyle;
  const prevMatrix = globalThis.DOMMatrixReadOnly;
  const hadMatrix = typeof prevMatrix === 'function';
  globalThis.getComputedStyle = (node) => ({
    transform: node?.translateY ? `matrix(1, 0, 0, 1, 0, ${node.translateY})` : 'none',
  });
  if (!hadMatrix) {
    globalThis.DOMMatrixReadOnly = class {
      constructor(transform) {
        const body = String(transform).slice(String(transform).indexOf('(') + 1, String(transform).indexOf(')'));
        const parts = body.split(',').map((part) => Number(part.trim()));
        this.m42 = parts[5] || 0;
      }
    };
  }
  try {
    run();
  } finally {
    if (prevStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prevStyle;
    if (!hadMatrix) delete globalThis.DOMMatrixReadOnly;
  }
}

test('a row mid-rise whose slot did not change is not re-animated', () => {
  withTranslate(() => {
    const row = fakeRow('239900', 532);
    const flip = createSuggestFlip();
    flip.update(fakeList([row]));
    row.top = 0;
    flip.update(fakeList([row]));
    assert.equal(row.animations.length, 1);
    assert.deepEqual(row.animations[0].keyframes[0], { transform: 'translateY(532px)' });
    // Progressive paint: layout slot is still 0, but the slide's translate
    // is in the visual rect. That must not cancel and replay the 532px rise.
    row.translateY = 532;
    row.top = 532;
    flip.update(fakeList([row]));
    flip.update(fakeList([row]));
    assert.equal(row.animations.length, 1);
    assert.equal(row.animations[0].cancelled, false);
  });
});

test('an interrupted rise restarts from the current visual position, not the old slot', () => {
  withTranslate(() => {
    const row = fakeRow('a', 300);
    const flip = createSuggestFlip();
    flip.update(fakeList([row]));
    row.top = 100;
    flip.update(fakeList([row]));
    assert.deepEqual(row.animations[0].keyframes[0], { transform: 'translateY(200px)' });
    // Layout slot rises from 100 to 40 while translateY(80) is still applied,
    // so the rect sits at 120. Restart from that visual offset (80), not from
    // the old slot (100 - 40 = 60).
    row.translateY = 80;
    row.top = 120;
    flip.update(fakeList([row]));
    assert.equal(row.animations[0].cancelled, true);
    assert.equal(row.animations.length, 2);
    assert.deepEqual(row.animations[1].keyframes[0], { transform: 'translateY(80px)' });
  });
});

test('scrolling the list is not row motion', () => {
  const row = fakeRow('a', 100);
  const flip = createSuggestFlip();
  const root = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [row],
  };
  flip.update(root);
  root.scrollTop = 40;
  row.top = 60;
  flip.update(root);
  assert.equal(row.animations.length, 0);
});
