import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsernameInput, usernameProblem } from './username.js';

test('username input is normalised the way the API stores it', () => {
  assert.equal(normalizeUsernameInput('@Ash Ketchum'), 'ashketchum');
  assert.equal(normalizeUsernameInput('Pokémon_Fan-99'), 'pokemonfan99');
  assert.equal(normalizeUsernameInput('x'.repeat(40)).length, 32);
});

test('username problems explain what to fix', () => {
  assert.equal(usernameProblem('mario88', 'pokoin'), '');
  assert.match(usernameProblem('', 'pokoin'), /Pick a username/);
  assert.match(usernameProblem('ab', 'pokoin'), /at least 3/);
  assert.match(usernameProblem('Pokoin', 'pokoin'), /already your username/);
});
