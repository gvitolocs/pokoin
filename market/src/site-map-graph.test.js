import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildModel,
  createSearch,
  neighbors,
  nodeInfo,
  position,
  refFromKey,
  refKey,
  templateLinks,
} from './site-map-graph.js';

const data = JSON.parse(readFileSync(new URL('../public/data/site-map.json', import.meta.url), 'utf8'));
const model = buildModel(data);

test('every card star lands inside its set disc', () => {
  assert.equal(model.count, data.cards.id.length);
  assert.equal(data.sets.reduce((s, set) => s + set.n, 0), model.count);
  for (let i = 0; i < model.count; i += 97) {
    const s = model.cardSet[i];
    const set = data.sets[s];
    assert.ok(Math.hypot(model.cx[i] - set.x, model.cy[i] - set.y) <= model.setR[s], `card ${i} outside ${set.slug}`);
  }
});

test('refs round-trip through the ?focus= key', () => {
  const samples = [
    { kind: 'card', i: 123 },
    refFromKey(model, 'set:base-set'),
    refFromKey(model, 'pokemon:pikachu'),
    { kind: 'artist', i: 0 },
    { kind: 'era', i: 0 },
    refFromKey(model, 'page:/marketplace/sets'),
  ];
  for (const ref of samples) {
    assert.ok(ref, 'sample resolves');
    assert.deepEqual(refFromKey(model, refKey(model, ref)), ref);
  }
  assert.equal(refFromKey(model, 'set:not-a-real-set'), null);
  assert.equal(refFromKey(model, 'nonsense'), null);
});

test('a card desk links to its set, Pokémon, and set language hub', () => {
  const set = refFromKey(model, 'set:base-set');
  const start = model.setStart[set.i];
  const charizard = Array.from({ length: data.sets[set.i].n }, (_, k) => start + k)
    .find((i) => data.names[data.cards.name[i]] === 'Charizard');
  assert.ok(charizard != null, 'Base Set Charizard is on the map');
  const ref = { kind: 'card', i: charizard };
  const info = nodeInfo(model, ref);
  assert.match(info.href, /^\/marketplace\/en\/cards\/\d+$/);
  assert.match(info.sub, /4\/102 · Base Set/);
  const out = neighbors(model, ref).out.flatMap((g) => g.refs);
  const labels = out.map((r) => nodeInfo(model, r).label);
  assert.ok(labels.includes('Base Set'));
  assert.ok(labels.includes('Charizard'));
  assert.ok(labels.includes('English'));
});

test('index pages fan out to every instance; templates count their pages', () => {
  const sets = refFromKey(model, 'page:/marketplace/sets');
  const setGroup = neighbors(model, sets).out.find((g) => g.key === 'sets');
  assert.equal(setGroup.refs.length, data.sets.length);
  const card = refFromKey(model, 'page:/marketplace/:lang/cards/:cardId/:slug?');
  assert.equal(neighbors(model, card).instances.count, model.count);
  const pokemon = neighbors(model, refFromKey(model, 'pokemon:pikachu'));
  assert.equal(pokemon.out.find((g) => g.key === 'cards').refs.length, data.species[refFromKey(model, 'pokemon:pikachu').i].n);
});

test('inherited template links skip what the map already draws', () => {
  const ids = templateLinks(model, 'card').map((r) => data.pages[r.i].id);
  assert.ok(!ids.includes('/marketplace/sets/:slug'));
  assert.ok(!ids.includes('/marketplace/:lang/pokemon/:slug'));
});

test('the header & footer node links to the site map itself', () => {
  const shell = { kind: 'page', i: model.shell };
  const out = neighbors(model, shell).out.flatMap((g) => g.refs).map((r) => data.pages[r.i].id);
  assert.ok(out.includes('/sitemap'));
  assert.ok(out.includes('/marketplace/sets'));
});

test('search puts hubs before card desks and folds accents', () => {
  const search = createSearch(model);
  const [first] = search('base set');
  assert.deepEqual(first, refFromKey(model, 'set:base-set'));
  const pokemon = search('pokemon');
  assert.ok(pokemon.some((r) => r.kind === 'page' && data.pages[r.i].label === 'Pokémon'));
  const cards = search('charizard', 10);
  assert.equal(cards[0].kind, 'species');
  assert.ok(cards.some((r) => r.kind === 'card'));
  assert.deepEqual(search('   '), []);
});

test('rings sit outside the galaxy', () => {
  const { radii } = data;
  assert.ok(radii.core < radii.galaxy && radii.galaxy < radii.species && radii.species < radii.artists);
  const [x, y] = position(model, { kind: 'species', i: 0 });
  assert.ok(Math.abs(Math.hypot(x, y) - radii.species) < 0.05);
});
