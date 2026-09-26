import assert from 'node:assert/strict';
import test from 'node:test';
import { gameSiteHref } from './game.js';

test('the game picker sends each TCG to its own site', () => {
  assert.equal(gameSiteHref('pokemon'), 'https://pokoin.com/marketplace');
  assert.equal(gameSiteHref('one_piece'), 'https://onepiece.pokoin.com/marketplace');
  assert.equal(gameSiteHref('riftbound'), 'https://riftbound.pokoin.com/marketplace');
  assert.equal(gameSiteHref(''), 'https://pokoin.com/marketplace');
});
