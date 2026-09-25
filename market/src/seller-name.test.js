import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerNameOf } from './auth-session.js';

test('sellerNameOf prefers real displayName, then username, never email', () => {
  assert.equal(sellerNameOf({ displayName: 'Simone', email: 'a@b.c' }, { username: 'redshakkio' }), 'Simone');
  assert.equal(sellerNameOf({ displayName: '', email: 'redshakkio@gmail.com' }, { username: 'redshakkio' }), 'redshakkio');
  assert.equal(sellerNameOf({ displayName: 'redshakkio@gmail.com', email: 'redshakkio@gmail.com' }, { username: 'redshakkio' }), 'redshakkio');
  assert.equal(sellerNameOf({ email: 'redshakkio@gmail.com' }, null), 'Pokoin seller');
  assert.equal(sellerNameOf(null, { username: 'redshakkio' }), 'redshakkio');
  assert.equal(sellerNameOf({ displayName: 'Simone' }, { username: 'redshakkio', displayName: 'Giuseppe' }), 'Giuseppe');
});
