import assert from 'node:assert/strict';
import test from 'node:test';
import { exactNameQuery, filterExactNameRows, namesEqual } from './exact-name.js';

test('exactNameQuery quotes the catalog name', () => {
  assert.equal(exactNameQuery('Wondrous Patch'), '"Wondrous Patch"');
  assert.equal(exactNameQuery('  Espurr  '), '"Espurr"');
  assert.equal(exactNameQuery(''), '');
  assert.equal(exactNameQuery('Say "hi"'), '"Say hi"');
});

test('filterExactNameRows keeps only that name and skips the open card', () => {
  const rows = filterExactNameRows([
    { id: '713760', name: 'Wondrous Patch', set: 'Phantasmal Flames', number: '094/094' },
    { id: '736086', name: 'Wondrous Patch', set: 'Nihil Zero', number: '104/080', rarity: 'Ultra Rare' },
    { id: '259654', name: 'Wondrous Labyrinth ◇ Prism Star', set: 'Team Up', number: '158/181' },
    { id: '736086', name: 'Wondrous Patch', set: 'Nihil Zero', number: '104/080' },
  ], 'Wondrous Patch', { excludeId: '713760' });
  assert.deepEqual(rows.map((card) => card.id), ['736086']);
  assert.equal(rows[0].set, 'Nihil Zero');
});

test('namesEqual is case-insensitive and trimmed', () => {
  assert.equal(namesEqual('Wondrous Patch', 'wondrous patch'), true);
  assert.equal(namesEqual('Wondrous Patch', 'Wondrous Labyrinth'), false);
});
