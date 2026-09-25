import assert from 'node:assert/strict';
import test from 'node:test';
import { displayNameProblem, normalizeDisplayName } from './display-name.js';

test('display names keep spaces and accents and drop extra whitespace', () => {
  assert.equal(normalizeDisplayName('  Giuseppe   Vitolo '), 'Giuseppe Vitolo');
  assert.equal(normalizeDisplayName('Pokémon'), 'Pokémon');
  assert.equal(normalizeDisplayName('x'.repeat(50)).length, 40);
});

test('display name problems reject emails and tiny names', () => {
  assert.equal(displayNameProblem('Giuseppe'), '');
  assert.match(displayNameProblem(''), /Enter a name/);
  assert.match(displayNameProblem('A'), /at least 2/);
  assert.match(displayNameProblem('a@b.c'), /not an email/);
  assert.match(displayNameProblem('...'), /letter or number/);
});
