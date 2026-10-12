import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTEREST_MAX,
  buildInterestProfile,
  nameStem,
  personalPopup,
  noteCardView,
  personalizeGroups,
  predictInterest,
  preferredEras,
  printFamily,
  readInterestEvents,
} from './interest-profile.js';

const DAY = 86400000;
const NOW = 20000 * DAY + 3600000;

function memoryStore() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

const ERAS = { 'Base Set': 'Original', Jungle: 'Original', Fossil: 'Original', 'Lost Thunder': 'Sun & Moon', 'Paldea Evolved': 'Scarlet & Violet', 'Fairy Rise': 'Sun & Moon' };
const eraOf = (set) => ERAS[set] || '';

function view(store, id, name, set, print, daysAgo = 0) {
  return noteCardView({ id, name, set, nationality: print }, { store, now: NOW - daysAgo * DAY });
}

test('every printing of a creature is the same name to a visitor', () => {
  assert.equal(nameStem('Lugia V'), 'Lugia');
  assert.equal(nameStem('Lugia VSTAR'), 'Lugia');
  assert.equal(nameStem('Mimikyu GX'), 'Mimikyu');
  assert.equal(nameStem('M Rayquaza EX'), 'Rayquaza');
  assert.equal(nameStem('Charizard ex'), 'Charizard');
  assert.equal(nameStem("Erika's Invitation"), "Erika's Invitation");
  assert.equal(nameStem('V'), 'V', 'a name is never stripped to nothing');
  assert.equal(printFamily('korean'), 'japanese');
  assert.equal(printFamily('all'), '');
});

test('a view is stored once per card and day, and the list stays bounded', () => {
  const store = memoryStore();
  view(store, '1', 'Lugia V', 'Silver Tempest', 'western');
  view(store, '1', 'Lugia V', 'Silver Tempest', 'western');
  assert.equal(readInterestEvents('pokemon', store).length, 1, 'a refresh is not a second view');
  view(store, '1', 'Lugia V', 'Silver Tempest', 'western', -1);
  assert.equal(readInterestEvents('pokemon', store).length, 2, 'the next day it is');
  for (let i = 0; i < INTEREST_MAX + 20; i += 1) view(store, `c${i}`, 'Pikachu', 'Base Set', 'western');
  const events = readInterestEvents('pokemon', store);
  assert.equal(events.length, INTEREST_MAX);
  assert.equal(events.at(-1).id, `c${INTEREST_MAX + 19}`, 'the newest views are the ones kept');
  assert.deepEqual(noteCardView({ name: 'No id' }, { store, now: NOW }).length, INTEREST_MAX);
  assert.deepEqual(readInterestEvents('pokemon', { getItem: () => '{broken' }), []);
  assert.deepEqual(readInterestEvents('pokemon', null), []);
  assert.equal(readInterestEvents('magic', store).length, 0, 'each game has its own profile');
});

test('one letter offers the name the visitor has been viewing', () => {
  const store = memoryStore();
  for (let i = 0; i < 10; i += 1) view(store, `l${i}`, i % 2 ? 'Lugia V' : 'Lugia', 'Silver Tempest', 'western', 1);
  view(store, 'x1', 'Lucario', 'Base Set', 'western');
  const profile = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  assert.equal(predictInterest('l', profile).text, 'Lugia');
  assert.equal(predictInterest('L', profile).kind, 'name');
  assert.equal(predictInterest('lu', profile).text, 'Lugia');
  assert.equal(predictInterest('luc', profile), null, 'one view of Lucario is not a habit');
  assert.equal(predictInterest('z', profile), null);
  assert.equal(predictInterest('', profile), null);
  assert.equal(predictInterest('lugia', profile), null, 'typed in full, there is nothing to predict');
});

test('a name viewed days ago fades; a single view predicts nothing', () => {
  const store = memoryStore();
  for (let i = 0; i < 4; i += 1) view(store, `m${i}`, 'Mew', 'Fossil', 'western', 12);
  view(store, 'p1', 'Mewtwo', 'Base Set', 'western');
  const profile = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  assert.ok(profile.names.get('mew').score < 0.5, 'four views twelve days ago weigh less than half a view');
  assert.equal(predictInterest('m', profile), null);
});

test('the print chip decides which views count', () => {
  const store = memoryStore();
  for (let i = 0; i < 6; i += 1) view(store, `j${i}`, 'Mimikyu GX', 'Fairy Rise', 'japanese');
  for (let i = 0; i < 3; i += 1) view(store, `w${i}`, 'Mew', 'Fossil', 'western');
  const events = readInterestEvents('pokemon', store);
  const all = buildInterestProfile(events, { now: NOW, print: 'all', eraOf });
  assert.equal(predictInterest('m', all).text, 'Mimikyu');
  const western = buildInterestProfile(events, { now: NOW, print: 'western', eraOf });
  assert.equal(predictInterest('m', western).text, 'Mew', 'Japanese views predict nothing under Western print');
  assert.equal(western.sets.has('fairyrise'), false, 'nor do their expansions');
  const japanese = buildInterestProfile(events, { now: NOW, print: 'japanese', eraOf });
  assert.equal(predictInterest('m', japanese).text, 'Mimikyu');
  assert.equal(predictInterest('f', japanese).text, 'Fairy Rise', 'six views of one expansion make it a habit');
  assert.equal(predictInterest('f', japanese).kind, 'set');
});

test('the eras a visitor mostly views are their eras, once there are enough views', () => {
  const store = memoryStore();
  for (let i = 0; i < 4; i += 1) view(store, `b${i}`, 'Pikachu', 'Base Set', 'western');
  const few = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  assert.equal(preferredEras(few).size, 0, 'four views say little');
  for (let i = 0; i < 6; i += 1) view(store, `j${i}`, 'Clefairy', 'Jungle', 'western');
  view(store, 's1', 'Charizard ex', 'Paldea Evolved', 'western');
  const profile = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  assert.deepEqual([...preferredEras(profile)], ['Original']);
  assert.equal(preferredEras(buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW })).size, 0, 'no era table, no era taste');
});

const group = (name, sets) => ({ name, printings: sets.map((set, index) => ({ id: `${name}-${index}`, name, set })) });

test('printings from the visitor era come first, in the order they already had', () => {
  const store = memoryStore();
  for (let i = 0; i < 8; i += 1) view(store, `v${i}`, 'Clefairy', i % 2 ? 'Jungle' : 'Base Set', 'western');
  const profile = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  const groups = [group('Charizard', ['Paldea Evolved', 'Base Set', 'Lost Thunder', 'Fossil']), group('Charizard ex', ['Paldea Evolved'])];
  const mine = personalizeGroups(groups, 'chari', profile, { eraOf });
  assert.deepEqual(mine[0].printings.map((row) => row.set), ['Base Set', 'Fossil', 'Paldea Evolved', 'Lost Thunder']);
  assert.equal(mine[1], groups[1], 'a group with nothing to move is the same object');
  assert.deepEqual(groups[0].printings.map((row) => row.set)[0], 'Paldea Evolved', 'the input is not reordered in place');
  // A modern player sees the same list the other way round.
  const modern = memoryStore();
  for (let i = 0; i < 8; i += 1) view(modern, `s${i}`, 'Miraidon ex', 'Paldea Evolved', 'western');
  const player = buildInterestProfile(readInterestEvents('pokemon', modern), { now: NOW, eraOf });
  assert.deepEqual(personalizeGroups(groups, 'chari', player, { eraOf })[0].printings.map((row) => row.set),
    ['Paldea Evolved', 'Base Set', 'Lost Thunder', 'Fossil']);
});

test('among names that start with the typed text the viewed one leads, never above an exact match', () => {
  const store = memoryStore();
  for (let i = 0; i < 5; i += 1) view(store, `m${i}`, 'Mewtwo V', 'Lost Thunder', 'western');
  const profile = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  const groups = [group('Mew', ['Fossil']), group('Mew ex', ['Paldea Evolved']), group('Mewtwo', ['Base Set']), group('Meowth', ['Jungle'])];
  assert.deepEqual(personalizeGroups(groups, 'mew', profile, { eraOf }).map((row) => row.name), ['Mew', 'Mewtwo', 'Mew ex', 'Meowth']);
  // `Meowth` does not start with `mew`: it and everything after it stay put.
  assert.deepEqual(personalizeGroups(groups, 'me', profile, { eraOf }).map((row) => row.name), ['Mewtwo', 'Mew', 'Mew ex', 'Meowth']);
});

test('a query that is not the start of a name comes back untouched', () => {
  const store = memoryStore();
  for (let i = 0; i < 8; i += 1) view(store, `v${i}`, 'Shieldon', 'Base Set', 'western');
  const profile = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  const groups = [group('Shieldon', ['Lost Thunder', 'Base Set'])];
  assert.equal(personalizeGroups(groups, '061 shieldon', profile, { eraOf }), groups);
  assert.equal(personalizeGroups(groups, 'hgss energy', profile, { eraOf }), groups);
  assert.equal(personalizeGroups(groups, 'shield', buildInterestProfile([], { now: NOW }), { eraOf }), groups, 'no profile, no change');
  assert.deepEqual(personalizeGroups(null, 'x', profile, { eraOf }), []);
});

test('an era the visitor collects picks its twenty from a wider ranking', () => {
  const store = memoryStore();
  for (let i = 0; i < 8; i += 1) view(store, `s${i}`, 'Miraidon ex', 'Paldea Evolved', 'western');
  const player = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  // The ranking's own order: old printings first, the modern ones past the cut.
  const ranked = group('Charizard', ['Base Set', 'Jungle', 'Fossil', 'Lost Thunder', 'Paldea Evolved', 'Paldea Evolved']);
  const asked = [];
  const paint = (limit) => {
    asked.push(limit);
    return [{ ...ranked, printings: ranked.printings.slice(0, limit) }];
  };
  const popup = personalPopup(paint, 'chari', player, { eraOf, limit: 3, pool: 6 });
  assert.deepEqual(asked, [3, 6]);
  assert.deepEqual(popup[0].printings.map((row) => row.set), ['Paldea Evolved', 'Paldea Evolved', 'Base Set']);
  // Nobody's profile, or a query that is not a name: the ranking's own rows, asked once.
  asked.length = 0;
  const plain = personalPopup(paint, 'chari', buildInterestProfile([], { now: NOW, eraOf }), { eraOf, limit: 3, pool: 6 });
  assert.deepEqual(plain[0].printings.map((row) => row.set), ['Base Set', 'Jungle', 'Fossil']);
  personalPopup(paint, '4/102 chari', player, { eraOf, limit: 3, pool: 6 });
  assert.deepEqual(asked, [3, 3], 'no wider ranking for either');
  assert.deepEqual(personalPopup(() => [], 'chari', player, { eraOf }), []);
});

test('a wider pool is cut back to the popup size across groups', () => {
  const store = memoryStore();
  for (let i = 0; i < 8; i += 1) view(store, `s${i}`, 'Miraidon ex', 'Paldea Evolved', 'western');
  const player = buildInterestProfile(readInterestEvents('pokemon', store), { now: NOW, eraOf });
  const groups = [group('Charizard', ['Base Set', 'Paldea Evolved', 'Fossil']), group('Charizard ex', ['Paldea Evolved', 'Lost Thunder']), group('Charmander', ['Base Set'])];
  const cut = personalizeGroups(groups, 'char', player, { eraOf, limit: 4 });
  assert.deepEqual(cut.map((row) => [row.name, row.printings.map((p) => p.set)]), [
    ['Charizard', ['Paldea Evolved', 'Base Set', 'Fossil']],
    ['Charizard ex', ['Paldea Evolved']],
  ]);
});
