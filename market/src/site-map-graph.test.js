import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildModel,
  compareOverlap,
  compareStats,
  marketSummary,
  matchCards,
  neighbors as neighborsOf,
  priceBucket,
  shortestPath,
  suggestKeywords,
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

test('Flabébé has its cards on the map (accent-folded Pokédex #669)', () => {
  const flabebe = refFromKey(model, 'pokemon:flabebe');
  assert.ok(data.species[flabebe.i].n > 0);
});

test('six degrees: every hop of a path is a real link', () => {
  const from = refFromKey(model, 'pokemon:pikachu');
  const to = refFromKey(model, 'pokemon:charizard');
  const path = shortestPath(model, from, to);
  assert.ok(path && path.length >= 3);
  assert.deepEqual(path[0], from);
  assert.deepEqual(path[path.length - 1], to);
  for (let n = 1; n < path.length; n += 1) {
    const { out, into } = neighborsOf(model, path[n - 1]);
    const linked = [...out, ...into].flatMap((g) => g.refs).some((r) => r.kind === path[n].kind && r.i === path[n].i);
    assert.ok(linked, `hop ${n} ${path[n - 1].kind}→${path[n].kind} is a link`);
  }
  assert.equal(shortestPath(model, from, from).length, 1);
  assert.equal(shortestPath(model, from, { kind: 'page', i: 0 }), null);
});

test('market summary counts listed desks and finds the cheapest', () => {
  const set = refFromKey(model, 'set:base-set');
  const summary = marketSummary(model, set);
  assert.equal(summary.total, data.sets[set.i].n);
  assert.ok(summary.listed <= summary.total);
  if (summary.cheapest) {
    const cheapest = data.cards.pkn[summary.cheapest.i];
    const start = model.setStart[set.i];
    for (let k = 0; k < summary.total; k += 1) {
      const pkn = data.cards.pkn[start + k];
      if (pkn > 0) assert.ok(pkn >= cheapest);
    }
  }
  for (let i = 0; i < model.count; i += 1009) {
    assert.equal(priceBucket(model, i) >= 0, data.cards.pkn[i] > 0);
  }
});

test('review boards and plumbing routes are not on the map', () => {
  for (const id of ['/tests', '/sanitize', '/espurr', '/ocr', '/ocr/artists', '/artwork', '/jumbos', '/extension/auth-bridge']) {
    assert.equal(refFromKey(model, `page:${id}`), null, id);
  }
  assert.ok(refFromKey(model, 'page:/marketplace'));
});

test('compare matches a keyword at a word start and summarises it', () => {
  const lucario = matchCards(model, 'lucario');
  assert.ok(lucario.length > 0);
  for (const i of lucario.slice(0, 50)) assert.match(data.names[data.cards.name[i]], /(^|[^a-z])lucario/i);
  assert.ok(matchCards(model, 'Flabébé').length > 0);
  assert.equal(matchCards(model, '   ').length, 0);
  const stats = compareStats(model, lucario);
  assert.equal(stats.cards, lucario.length);
  assert.ok(stats.listed <= stats.cards && stats.sets > 0 && stats.eras.length > 0);
});

test('compare suggests word-start keywords with desk counts, Pokémon first', () => {
  const hits = suggestKeywords(model, 'luca');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].text, 'lucario');
  assert.ok(hits[0].species);
  assert.equal(hits[0].n, matchCards(model, 'lucario').length);
  assert.deepEqual(suggestKeywords(model, ''), []);
});

test('compare overlap finds shared sets, artists and desks holding every keyword', () => {
  const rows = ['lucario', 'melmetal'].map((term) => {
    const cards = matchCards(model, term);
    return { term, cards, stats: compareStats(model, cards) };
  });
  const overlap = compareOverlap(model, rows);
  assert.ok(overlap.sets.length > 0 && overlap.artists.length > 0);
  assert.ok(overlap.cards.some(({ i }) => /lucario & melmetal/i.test(data.names[data.cards.name[i]])));
  assert.equal(compareOverlap(model, rows.slice(0, 1)), null);
  const stats = rows[0].stats;
  assert.equal(stats.mix.reduce((s, n) => s + n, 0), stats.listed);
  assert.ok(stats.debut >= 0 && stats.debut <= stats.latest);
});
