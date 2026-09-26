import assert from 'node:assert/strict';
import test from 'node:test';
import { gameSiteHref } from './game.js';

test('the game picker sends each TCG to its own site', () => {
  assert.equal(gameSiteHref('pokemon'), 'https://pokoin.com/marketplace');
  assert.equal(gameSiteHref('one_piece'), 'https://pokoin.com/one-piece/marketplace');
  assert.equal(gameSiteHref('riftbound'), 'https://pokoin.com/riftbound/marketplace');
  assert.equal(gameSiteHref('magic'), 'https://pokoin.com/magic/marketplace');
  assert.equal(gameSiteHref(''), 'https://pokoin.com/marketplace');
});
