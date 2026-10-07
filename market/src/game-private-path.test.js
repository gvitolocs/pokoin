import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GAME_PRIVATE_CHILD_SEGMENTS,
  GAME_PRIVATE_SEGMENTS,
  isGamePrivatePath,
} from './game-private-path.js';

test('game private paths are the account and marketing duplicates', () => {
  for (const segment of [
    'wallet', 'profile', 'dashboard', 'orders', 'flex', 'ambassadorprogram',
    'auth', 'messages', 'cart',
  ]) {
    assert.equal(isGamePrivatePath(`/${segment}`), true, segment);
    assert.equal(GAME_PRIVATE_SEGMENTS.includes(segment), true, segment);
  }
  assert.equal(isGamePrivatePath('/messages/ada'), true);
  assert.equal(isGamePrivatePath('/marketplace'), false);
  assert.equal(isGamePrivatePath('/marketplace/en/cards/1/luffy'), false);
  assert.equal(isGamePrivatePath('/news/op-14'), false);
  assert.equal(isGamePrivatePath('/product/box'), false);
  assert.equal(isGamePrivatePath('/careers'), true);
});

test('child splats are a subset of the edge redirect list', () => {
  for (const segment of GAME_PRIVATE_CHILD_SEGMENTS) {
    assert.equal(GAME_PRIVATE_SEGMENTS.includes(segment), true, segment);
  }
});
