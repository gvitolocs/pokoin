import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseResolutionParam,
  resolveSuggestQuery,
  serializeResolution,
} from './suggest-resolve.js';

function entitiesOf(query) {
  const resolved = resolveSuggestQuery(query);
  assert.ok(resolved?.best, `${query} should resolve`);
  return resolved;
}

test('multi-token free text binds the name and artist separately', () => {
  const resolved = entitiesOf('pika yuka');
  const { name, artist } = resolved.best.entities;
  assert.equal(name[0]?.display, 'Pikachu');
  assert.equal(artist[0]?.slug, 'yuka-morii');
  assert.ok(resolved.hasArtist);
});

test('a substitution typo still binds the artist', () => {
  const resolved = entitiesOf('kawayod');
  assert.equal(resolved.best.entities.artist[0]?.slug, 'kawayoo');
});

test('single-word artist prefixes bind through the trie', () => {
  const resolved = entitiesOf('kawayo');
  assert.equal(resolved.best.entities.artist[0]?.slug, 'kawayoo');
});

test('an exact single name locks without set interference', () => {
  const resolved = entitiesOf('pikachu');
  assert.equal(resolved.best.entities.name[0]?.display, 'Pikachu');
  assert.equal(resolved.best.entities.set.length, 0);
  assert.equal(resolved.best.locked, true);
});

test('exact multi-word blueprint names lock as one span', () => {
  const resolved = entitiesOf('palkia & dialga legend');
  assert.equal(resolved.best.entities.name[0]?.display, 'Palkia & Dialga LEGEND');
  assert.equal(resolved.best.spans.length, 1);
  assert.equal(resolved.best.locked, true);
});

test('an exact blueprint name never peels as a set title', () => {
  const resolved = entitiesOf('eevee i');
  assert.equal(resolved.best.entities.name[0]?.display, 'Eevee');
  assert.equal(resolved.best.entities.set.length, 0);
});

test('collector numbers stay protected while the name ranks exactly', () => {
  const resolved = entitiesOf('061 shieldon');
  assert.equal(resolved.best.entities.name[0]?.display, 'Shieldon');
  assert.equal(resolved.parsed.numberTokens.length > 0, true);
});

test('set phrases bind as one span next to the name', () => {
  const resolved = entitiesOf('flareon call of legends');
  assert.equal(resolved.best.entities.name[0]?.display, 'Flareon');
  assert.ok(resolved.best.entities.set.some((entity) => entity.display === 'Call of Legends'));
});

test('popularity only breaks ties between same-cost interpretations', () => {
  const resolved = entitiesOf('pika');
  assert.equal(resolved.best.entities.name[0]?.display, 'Pikachu');
});

test('name typos within the typo budget recover the species', () => {
  const resolved = entitiesOf('talflamd');
  assert.equal(resolved.best.entities.name[0]?.display, 'Talonflame');
});

test('artist full names resolve as one phrase span', () => {
  const resolved = entitiesOf('tomokazu komiya');
  assert.equal(resolved.best.entities.artist[0]?.slug, 'tomokazu-komiya');
  assert.equal(resolved.best.spans.length, 1);
});

test('short set codes still bind as sets next to the name', () => {
  const resolved = entitiesOf('palkai sl');
  assert.ok(resolved.best.entities.set.some((entity) => entity.display === 'Call of Legends'));
});

test('relaxation tiers drop constraints before dropping the entity', () => {
  const resolved = entitiesOf('pika yuka');
  assert.ok(resolved.tiers.length >= 2);
  const relaxed = resolved.tiers[1];
  assert.equal(relaxed.entities.artist.length + relaxed.entities.name.length, 1);
});

test('serialization round-trips through the URL param', () => {
  const resolved = entitiesOf('pika yuka');
  const serialized = serializeResolution(resolved);
  assert.match(serialized, /name:Pikachu/);
  assert.match(serialized, /artist:yuka-morii/);
  const parsed = parseResolutionParam(serialized);
  assert.deepEqual(parsed.names, ['Pikachu']);
  assert.deepEqual(parsed.artists, ['yuka-morii']);
});
