import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_LEVEL,
  COLLECTIONS_LEVEL,
  collectionSeries,
  collectionSeriesOn,
  collectionsModel,
  defaultSegmentLevel,
  formatSegmentChange,
  indexedSeries,
  joinedSegments,
  normalizeSegmentDefs,
  normalizeSegments,
  segmentGroups,
  segmentLevels,
  segmentWindow,
  smoothPath,
  sparkEndPoint,
  sparkPoints,
  versusPaths,
  withCollections,
} from './portfolio-segments.js';

const DEFS = [
  { key: 'game:pokemon', group: 'game', game: 'pokemon' },
  { key: 'game:riftbound', group: 'game', game: 'riftbound' },
  { key: 'all:sealed', group: 'type', game: 'all', label: 'Sealed' },
  { key: 'all:graded', group: 'type', game: 'all', label: 'Graded' },
  { key: 'pokemon:era:sv', group: 'era', game: 'pokemon', label: 'Scarlet & Violet', years: [2023, 2026] },
  { key: 'pokemon:era:swsh', group: 'era', game: 'pokemon', label: 'Sword & Shield', years: [2019, 2023] },
  { key: 'pokemon:sealed', group: 'type', game: 'pokemon', label: 'Sealed' },
  { key: 'pokemon:graded', group: 'type', game: 'pokemon', label: 'Graded' },
];

function answer(days, defs = DEFS) {
  return { ok: true, days, segmentDefs: defs };
}

/** Every `[x, y]` of a smoothPath `d`, sampled along the real cubics. */
function sampledYs(d, steps = 40) {
  const numbers = (text) => text.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g).map(Number);
  const ys = [];
  let cursor = null;
  for (const command of d.match(/[MC][^MC]*/g) || []) {
    const parts = numbers(command.slice(1));
    if (command[0] === 'M') {
      cursor = { x: parts[0], y: parts[1] };
      ys.push(parts[1]);
      continue;
    }
    for (let i = 0; i + 6 <= parts.length; i += 6) {
      const [cx1, cy1, cx2, cy2, x1, y1] = parts.slice(i, i + 6);
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        const mt = 1 - t;
        ys.push((mt ** 3) * cursor.y + 3 * (mt ** 2) * t * cy1 + 3 * mt * (t ** 2) * cy2 + (t ** 3) * y1);
      }
      cursor = { x: x1, y: y1 };
    }
  }
  return ys;
}

test('normalizeSegments keeps the defs and the days a segment lives on', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-02', cardsValuePkn: 900, segments: { 'game:pokemon': [900, 12, 40] } },
    { date: '2026-11-01', cardsValuePkn: 800, segments: { 'game:pokemon': [800, 10, 40] } },
    // An old day with no segments at all is still the collection's day.
    { date: '2026-10-31', cardsValuePkn: 700 },
  ]));
  assert.deepEqual(model.days.map((day) => day.date), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(model.days[0].segments, {});
  assert.deepEqual(model.days[2].segments['game:pokemon'], { valuePkn: 900, priced: 12, held: 40 });
  assert.equal(model.defs.length, DEFS.length);
  assert.equal(model.defs[0].key, 'game:pokemon');
});

test('normalizeSegments answers null for junk and for a server without segments', () => {
  for (const junk of [null, undefined, 0, 'nope', [], {}, { days: 'x' }]) {
    assert.equal(normalizeSegments(junk), null, JSON.stringify(junk));
  }
  // Defs but no day ever carrying segments (an old server).
  assert.equal(normalizeSegments(answer([{ date: '2026-11-01', cardsValuePkn: 10 }])), null);
  // Segments but no defs to table them with.
  assert.equal(normalizeSegments({ ok: true, days: [{ date: '2026-11-01', cardsValuePkn: 10, segments: { a: [1, 1, 1] } }] }), null);
});

test('normalizeSegments drops malformed segment entries and values', () => {
  const model = normalizeSegments(answer([
    {
      date: '2026-11-01',
      cardsValuePkn: -5,
      segments: {
        'game:pokemon': [100, 2, 4],
        'all:sealed': [100, 2],
        'all:graded': [100, 2, 4, 9],
        'pokemon:era:sv': ['a', 2, 4],
        'pokemon:era:swsh': [-1, 2, 4],
        'pokemon:sealed': [Number.NaN, 2, 4],
        'pokemon:graded': 'nope',
      },
    },
  ]));
  assert.deepEqual(Object.keys(model.days[0].segments), ['game:pokemon']);
  assert.equal(model.days[0].cardsValuePkn, null);
  // A malformed def never reaches the table.
  const withJunkDefs = normalizeSegments(answer(
    [{ date: '2026-11-01', cardsValuePkn: 1, segments: { 'game:pokemon': [1, 1, 1] } }],
    [{ key: 'game:pokemon', group: 'game', game: 'pokemon' }, { key: 'x', group: 'nonsense' }, { group: 'game' }, { key: 'game:pokemon', group: 'game', game: 'pokemon' }],
  ));
  assert.deepEqual(withJunkDefs.defs, [{ key: 'game:pokemon', group: 'game', game: 'pokemon', label: '', years: undefined }]);
});

test('segmentLevels: all first, then a level per game with era or type rows', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 10, segments: { 'game:pokemon': [10, 1, 1] } },
  ]));
  assert.deepEqual(segmentLevels(model), [
    { id: 'all', label: 'All games' },
    { id: 'pokemon', label: 'Pokémon' },
  ]);
  assert.deepEqual(segmentLevels(null), []);
  // Only game rows: there is nothing to drill into, so `all` stands alone.
  const gamesOnly = normalizeSegments({
    ok: true,
    days: [{ date: '2026-11-01', cardsValuePkn: 10, segments: { 'game:riftbound': [10, 1, 1] } }],
    segmentDefs: [{ key: 'game:riftbound', group: 'game', game: 'riftbound' }],
  });
  assert.deepEqual(segmentLevels(gamesOnly), [{ id: ALL_LEVEL, label: 'All games' }]);
  // An unknown game id falls back to the id itself.
  const unknown = normalizeSegments({
    ok: true,
    days: [{ date: '2026-11-01', cardsValuePkn: 10, segments: { 'game:mystery': [10, 1, 1] } }],
    segmentDefs: [
      { key: 'game:mystery', group: 'game', game: 'mystery' },
      { key: 'mystery:graded', group: 'type', game: 'mystery', label: 'Graded' },
    ],
  });
  assert.deepEqual(segmentLevels(unknown).map((level) => level.id), ['all', 'mystery']);
  assert.equal(segmentLevels(unknown)[1].label, 'mystery');
});

test('segmentGroups lays out both levels and skips an empty group', () => {
  const model = normalizeSegments(answer([
    {
      date: '2026-11-01',
      cardsValuePkn: 1000,
      segments: {
        'game:pokemon': [1000, 9, 30],
        'game:riftbound': [0, 0, 40],
        'all:sealed': [90, 4, 4],
        'pokemon:era:sv': [600, 5, 18],
      },
    },
  ]));
  const all = segmentGroups(model, 'all', {});
  assert.deepEqual(all.map((group) => group.title), ['Games', 'Across all games']);
  assert.deepEqual(all[0].rows.map((row) => row.label), ['Pokémon', 'Riftbound']);
  assert.deepEqual(all[1].rows.map((row) => row.label), ['Sealed', 'Graded']);

  const pokemon = segmentGroups(model, 'pokemon', {});
  assert.deepEqual(pokemon.map((group) => group.title), ['Eras', 'Types']);
  assert.deepEqual(pokemon[0].rows.map((row) => row.label), ['Scarlet & Violet', 'Sword & Shield']);
  assert.deepEqual(pokemon[1].rows.map((row) => row.state), ['empty', 'empty']);
  // The era's years are the muted sub line; a row without them has none.
  assert.equal(pokemon[0].rows[0].sub, '2023–2026');
  assert.equal(pokemon[0].rows[1].sub, '2019–2023');
  assert.equal(all[0].rows[0].sub, '');

  // A level with no rows at all is no table.
  assert.deepEqual(segmentGroups(model, 'riftbound', {}), []);
  assert.deepEqual(segmentGroups(null, 'all', {}), []);
});

test('a game whose only drill-down rows are sets gets its own level', () => {
  // DG-R007 sends `<game>:set:<slug>` rows for the games without era bands, so
  // `set` is a level group too and a def of that group survives normalization.
  const model = normalizeSegments({
    ok: true,
    days: [{ date: '2026-11-01', cardsValuePkn: 10, segments: { 'game:riftbound': [10, 1, 1] } }],
    segmentDefs: [
      { key: 'game:pokemon', group: 'game', game: 'pokemon' },
      { key: 'game:riftbound', group: 'game', game: 'riftbound' },
      { key: 'all:sealed', group: 'type', game: 'all', label: 'Sealed' },
      { key: 'all:graded', group: 'type', game: 'all', label: 'Graded' },
      { key: 'riftbound:set:origins', group: 'set', game: 'riftbound', label: 'Origins' },
      { key: 'riftbound:set:other', group: 'set', game: 'riftbound', label: 'Other sets' },
    ],
  });
  assert.ok(model, 'a set row is a segment def like any other');
  assert.deepEqual(segmentLevels(model).map((level) => level.id), ['all', 'riftbound']);
  assert.equal(segmentLevels(model)[1].label, 'Riftbound');
});

test('segmentGroups puts Sets between Eras and Types and keeps the defs order', () => {
  const model = normalizeSegments(answer([
    {
      date: '2026-11-01',
      cardsValuePkn: 1000,
      segments: {
        'game:pokemon': [940, 9, 30],
        'game:riftbound': [60, 4, 40],
        'riftbound:set:origins': [42, 3, 28],
        'riftbound:set:spiritforged': [18, 1, 12],
      },
    },
  ], [
    ...DEFS,
    { key: 'riftbound:set:spiritforged', group: 'set', game: 'riftbound', label: 'Spiritforged' },
    { key: 'riftbound:set:origins', group: 'set', game: 'riftbound', label: 'Origins' },
  ]));
  // The rows come in `segmentDefs` order, not sorted by name or value.
  const riftbound = segmentGroups(model, 'riftbound', {});
  assert.deepEqual(riftbound.map((group) => group.title), ['Sets']);
  assert.deepEqual(riftbound[0].rows.map((row) => row.label), ['Spiritforged', 'Origins']);
  assert.deepEqual(riftbound[0].rows.map((row) => row.state), ['ok', 'ok']);
  assert.equal(riftbound[0].rows[1].valuePkn, 42);
  // A game with all three groups reads Eras, Sets, Types.
  const withEras = normalizeSegments(answer(
    [{ date: '2026-11-01', cardsValuePkn: 10, segments: { 'riftbound:era:one': [10, 1, 1] } }],
    [
      { key: 'game:riftbound', group: 'game', game: 'riftbound' },
      { key: 'riftbound:era:one', group: 'era', game: 'riftbound', label: 'First era' },
      { key: 'riftbound:set:origins', group: 'set', game: 'riftbound', label: 'Origins' },
      { key: 'riftbound:graded', group: 'type', game: 'riftbound', label: 'Graded' },
    ],
  ));
  assert.deepEqual(
    segmentGroups(withEras, 'riftbound', {}).map((group) => group.title),
    ['Eras', 'Sets', 'Types'],
  );
});

test('segment rows carry the last day, a gap-free series and the window change', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 100, segments: { 'game:pokemon': [100, 10, 10] } },
    // The segment is absent that day: the row paints 0, not a hole.
    { date: '2026-11-02', cardsValuePkn: 120 },
    { date: '2026-11-03', cardsValuePkn: 110, segments: { 'game:pokemon': [110, 11, 10] } },
  ]));
  const row = segmentGroups(model, 'all', {})[0].rows[0];
  assert.deepEqual(row.series.map((point) => point.valuePkn), [100, 0, 110]);
  assert.deepEqual(row.series[1], { date: '2026-11-02', valuePkn: 0 });
  assert.deepEqual({ held: row.held, priced: row.priced, valuePkn: row.valuePkn }, { held: 10, priced: 11, valuePkn: 110 });
  assert.equal(row.changePct, 10);
  assert.equal(row.state, 'ok');
});

test('changePct starts at the first value above zero and needs two such days', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 0, segments: { 'game:pokemon': [0, 0, 8] } },
    { date: '2026-11-02', cardsValuePkn: 200, segments: { 'game:pokemon': [200, 4, 8] } },
    { date: '2026-11-03', cardsValuePkn: 217.2, segments: { 'game:pokemon': [217.2, 4, 8] } },
  ]));
  const row = segmentGroups(model, 'all', {})[0].rows[0];
  // 0 on the first day is not a base: 200 → 217.2 is +8.6%.
  assert.equal(row.changePct, 8.6);
  assert.equal(formatSegmentChange(row.changePct), '+8.6%');

  const single = normalizeSegments(answer([
    { date: '2026-11-02', cardsValuePkn: 200, segments: { 'game:pokemon': [200, 4, 8] } },
  ]));
  assert.equal(segmentGroups(single, 'all', {})[0].rows[0].changePct, null);
  const none = normalizeSegments(answer([
    { date: '2026-11-02', cardsValuePkn: 200, segments: { 'game:pokemon': [0, 0, 8] } },
  ]));
  assert.equal(segmentGroups(none, 'all', {})[0].rows[0].changePct, null);
});

test('a one-day series is one point, a flat series sits on the middle line', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-02', cardsValuePkn: 200, segments: { 'game:pokemon': [200, 4, 8] } },
    { date: '2026-11-03', cardsValuePkn: 200, segments: { 'game:pokemon': [200, 4, 8] } },
  ]));
  const oneDay = segmentGroups(model, 'all', { from: '2026-11-03', to: '2026-11-03' });
  assert.equal(oneDay[0].rows[0].series.length, 1);
  assert.equal(oneDay[0].rows[0].changePct, null);
  assert.deepEqual(sparkPoints(oneDay[0].rows[0].series.map((p) => p.valuePkn), 110, 26, 2), [[55, 13]]);

  const flat = sparkPoints([700, 700, 700], 100, 20, 2);
  assert.deepEqual(flat.map((p) => p[1]), [10, 10, 10]);
  assert.deepEqual(flat.map((p) => p[0]), [2, 50, 98]);
  assert.deepEqual(sparkPoints([], 100, 20, 2), []);
  // A rising series fills the box: high first value on top, lowest at the bottom.
  const rising = sparkPoints([1, 2, 3], 100, 20, 2);
  assert.equal(rising[0][1], 18);
  assert.equal(rising[2][1], 2);
});

test('sparkEndPoint puts the end dot on the last point of sparkPoints', () => {
  // sparkPoints answers `[x, y]` pairs: binding `.x`/`.y` off a pair straight
  // away leaves the circle at (0, 0), the corner rather than the last value.
  assert.deepEqual(sparkEndPoint(sparkPoints([1, 2, 3], 100, 20, 2)), { x: 98, y: 2 });
  assert.deepEqual(sparkEndPoint(sparkPoints([700, 700, 700], 100, 20, 2)), { x: 98, y: 10 });
  assert.deepEqual(sparkEndPoint(sparkPoints([5], 110, 26, 2)), { x: 55, y: 13 });
  // Nothing plotted, or a last point that is not a coordinate, is no dot at all.
  assert.equal(sparkEndPoint([]), null);
  assert.equal(sparkEndPoint(null), null);
  assert.equal(sparkEndPoint([[10, null]]), null);
  assert.equal(sparkEndPoint([['a', 'b']]), null);
  // The point's own shape is not part of the contract.
  assert.deepEqual(sparkEndPoint([{ x: 3, y: 4 }, { x: 5, y: 6 }]), { x: 5, y: 6 });
});

test('unpriced is held with no value anywhere, empty is nothing held', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 100, segments: { 'game:pokemon': [100, 10, 10], 'game:riftbound': [0, 0, 40] } },
    { date: '2026-11-02', cardsValuePkn: 100, segments: { 'game:pokemon': [100, 10, 10], 'game:riftbound': [0, 0, 40] } },
  ]));
  const rows = segmentGroups(model, 'all', {})[0].rows;
  assert.equal(rows[1].state, 'unpriced');
  assert.equal(rows[1].held, 40);
  assert.equal(rows[1].changePct, null);

  // Held nothing on the last day wins over any earlier value.
  const gone = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 100, segments: { 'game:pokemon': [100, 10, 10] } },
    { date: '2026-11-02', cardsValuePkn: 100, segments: { 'game:pokemon': [0, 0, 0] } },
  ]));
  const row = segmentGroups(gone, 'all', {})[0].rows[0];
  assert.equal(row.state, 'empty');
  assert.equal(row.held, 0);
  assert.equal(row.valuePkn, 0);

  // Absent on the last day is empty too.
  const absent = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 100, segments: { 'game:pokemon': [100, 10, 10] } },
    { date: '2026-11-02', cardsValuePkn: 100 },
  ]));
  assert.equal(segmentGroups(absent, 'all', {})[0].rows[0].state, 'empty');
});

test('the window bounds are inclusive on both edges', () => {
  const model = normalizeSegments(answer([
    { date: '2026-10-30', cardsValuePkn: 1, segments: { 'game:pokemon': [1, 1, 1] } },
    { date: '2026-10-31', cardsValuePkn: 2, segments: { 'game:pokemon': [2, 1, 1] } },
    { date: '2026-11-01', cardsValuePkn: 3, segments: { 'game:pokemon': [3, 1, 1] } },
    { date: '2026-11-02', cardsValuePkn: 4, segments: { 'game:pokemon': [4, 1, 1] } },
  ]));
  const closed = segmentGroups(model, 'all', { from: '2026-10-31', to: '2026-11-01' })[0].rows[0];
  assert.deepEqual(closed.series.map((point) => point.date), ['2026-10-31', '2026-11-01']);
  assert.equal(closed.valuePkn, 3);
  const openFrom = segmentGroups(model, 'all', { from: '', to: '2026-10-31' })[0].rows[0];
  assert.deepEqual(openFrom.series.map((point) => point.date), ['2026-10-30', '2026-10-31']);
  const openTo = segmentGroups(model, 'all', { from: '2026-11-01', to: '' })[0].rows[0];
  assert.deepEqual(openTo.series.map((point) => point.date), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(collectionSeries(model, { from: '2026-10-31', to: '2026-11-01' }).map((p) => p.valuePkn), [2, 3]);
});

test('collectionSeries reads the whole collection and keeps an unknown day unknown', () => {
  const model = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 500, segments: { 'game:pokemon': [500, 1, 1] } },
    { date: '2026-11-02', segments: { 'game:pokemon': [0, 0, 1] } },
    { date: '2026-11-03', cardsValuePkn: 600, segments: { 'game:pokemon': [600, 1, 1] } },
  ]));
  assert.deepEqual(collectionSeries(model, {}), [
    { date: '2026-11-01', valuePkn: 500 },
    { date: '2026-11-02', valuePkn: null },
    { date: '2026-11-03', valuePkn: 600 },
  ]);
  assert.deepEqual(collectionSeries(null, {}), []);
  // An unknown day is a gap, not a day the collection was worth nothing: it
  // indexes to null, so the compare line bridges it instead of falling to -100.
  assert.deepEqual(indexedSeries(collectionSeries(model, {})), [0, null, 20]);
  const drawn = versusPaths([0, null, 20], indexedSeries(collectionSeries(model, {})), 320, 150, 10);
  assert.equal((drawn.collection.match(/[MC][^MC]*/g) || []).length, 2, 'the gap drew more than one run');
  assert.equal(pathEnds(drawn.collection).first.x, 10);
  assert.equal(pathEnds(drawn.collection).last.x, 310);
  assert.ok(drawn.zeroY > 139, `0 % should sit at the bottom, not above a -100 % floor: ${drawn.zeroY}`);
});

test('segmentWindow anchors a preset to the newest day the model has', () => {
  const model = normalizeSegments(answer([
    { date: '2026-10-31', cardsValuePkn: 700, segments: { 'game:pokemon': [700, 8, 20] } },
    { date: '2026-11-01', cardsValuePkn: 800, segments: { 'game:pokemon': [800, 9, 20] } },
  ]));
  // A copy saved on the 1st read on the 18th with the 1W range: ending the
  // window on today would leave it empty and paint every row as "None held".
  const week = segmentWindow(model, { id: '1W', days: 7 }, '2026-11-18');
  assert.deepEqual(week, { from: '2026-10-25', to: '2026-11-01' });
  const row = segmentGroups(model, 'all', week)[0].rows[0];
  assert.deepEqual([row.valuePkn, row.priced, row.held], [800, 9, 20]);
  assert.equal(row.state, 'ok');
  // A series that reaches today keeps today as the end: nothing shifts back.
  assert.deepEqual(segmentWindow(model, { days: 7 }, '2026-11-01'), { from: '2026-10-25', to: '2026-11-01' });
  // A day newer than today (a clock that ran ahead) is not a day to end on.
  const ahead = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 800, segments: { 'game:pokemon': [800, 9, 20] } },
    { date: '2026-11-20', cardsValuePkn: 810, segments: { 'game:pokemon': [810, 9, 20] } },
  ]));
  assert.equal(segmentWindow(ahead, { days: 7 }, '2026-11-18').to, '2026-11-01');
  // MAX has no day count: the whole series, still ending today.
  assert.deepEqual(segmentWindow(model, { id: 'MAX', days: null }, '2026-11-18'), { from: '', to: '2026-11-18' });
  // A custom range carries its own two dates and wins over any day count.
  assert.deepEqual(
    segmentWindow(model, { id: 'custom', days: 12, from: '2026-10-30', to: '2026-11-01' }, '2026-11-18'),
    { from: '2026-10-30', to: '2026-11-01' },
  );
  // No model at all falls back to the plain count backwards from today.
  assert.deepEqual(segmentWindow(null, { days: 7 }, '2026-11-18'), { from: '2026-11-11', to: '2026-11-18' });
});

test('defaultSegmentLevel opens on All games only when two games hold cards', () => {
  const twoGames = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 900, segments: { 'game:pokemon': [900, 10, 30], 'game:riftbound': [0, 0, 40] } },
  ]));
  assert.equal(defaultSegmentLevel(twoGames), ALL_LEVEL);
  // Riftbound is an empty pile, so All games would be one real row and one
  // "None held": the desk opens on Pokémon, the only game with cards.
  const oneGame = normalizeSegments(answer([
    { date: '2026-11-01', cardsValuePkn: 900, segments: { 'game:pokemon': [900, 10, 30], 'game:riftbound': [0, 0, 0] } },
  ]));
  assert.equal(defaultSegmentLevel(oneGame), 'pokemon');
  // Only the newest day counts.
  const older = normalizeSegments(answer([
    { date: '2026-10-31', cardsValuePkn: 900, segments: { 'game:pokemon': [900, 10, 30], 'game:riftbound': [0, 0, 40] } },
    { date: '2026-11-01', cardsValuePkn: 900, segments: { 'game:pokemon': [900, 10, 30], 'game:riftbound': [0, 0, 0] } },
  ]));
  assert.equal(defaultSegmentLevel(older), 'pokemon');
  // No game rows at all: there is no game to open on but the era's own.
  const eraOnly = normalizeSegments(answer(
    [{ date: '2026-11-01', cardsValuePkn: 10, segments: { 'pokemon:era:sv': [10, 1, 1] } }],
    [{ key: 'pokemon:era:sv', group: 'era', game: 'pokemon', label: 'Scarlet & Violet' }],
  ));
  assert.equal(defaultSegmentLevel(eraOnly), 'pokemon');
  assert.equal(defaultSegmentLevel(null), ALL_LEVEL);
});

test('saved lists never move the level the table opens on', () => {
  const lists = { defs: [{ key: 'collection:c1', group: 'collection', game: '', label: 'Binder' }], days: [] };
  // A book whose only rows are the all-games ones, with lists saved on top of
  // it: the lists are the seller's, not a slice of the book, so they do not
  // compete for the opening level.
  const onlyAll = normalizeSegments(answer(
    [{ date: '2026-11-01', cardsValuePkn: 10, segments: { 'all:sealed': [10, 1, 1] } }],
    [{ key: 'all:sealed', group: 'type', game: 'all', label: 'Sealed' }],
  ));
  assert.deepEqual(segmentLevels(onlyAll).map((level) => level.id), [ALL_LEVEL]);
  assert.equal(defaultSegmentLevel(onlyAll), ALL_LEVEL);
  const withLists = withCollections(onlyAll, lists);
  assert.deepEqual(segmentLevels(withLists).map((level) => level.id), [ALL_LEVEL, COLLECTIONS_LEVEL]);
  assert.equal(defaultSegmentLevel(withLists), ALL_LEVEL, 'the same book answers the same with lists on it');
  // Nothing else to open on is the only case collections win.
  assert.equal(defaultSegmentLevel(withCollections(null, lists)), COLLECTIONS_LEVEL);
});

test('indexedSeries is percent against the first value above zero', () => {
  assert.deepEqual(indexedSeries([{ valuePkn: 0 }, { valuePkn: 200 }, { valuePkn: 250 }]), [null, 0, 25]);
  assert.deepEqual(indexedSeries([100, 50, 150]), [0, -50, 50]);
  assert.deepEqual(indexedSeries([0, 0]), [null, null]);
  assert.deepEqual(indexedSeries([]), []);
  assert.deepEqual(indexedSeries(null), []);
  assert.deepEqual(indexedSeries([{ valuePkn: null }, { valuePkn: 4 }, { valuePkn: 2 }]), [null, 0, -50]);
});

test('smoothPath is monotone and stays inside the value band', () => {
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([[10, 5]]), 'M 10 5');
  assert.match(smoothPath([[0, 1], [10, 2]]), /^M 0 1 C /);
  // Junk and a flat x never divide by zero.
  assert.equal(smoothPath([[Number.NaN, 1], [1, 2]]), 'M 1 2');
  assert.equal(smoothPath([[0, 1], [0, 9], [1, 2]]), 'M 0 1 C 0.333 1.333, 0.667 1.667, 1 2');

  const series = [4, 12, 7, 7, 22, 3, 9];
  const points = series.map((value, index) => [index * 20, 100 - value * 3]);
  const ys = sampledYs(smoothPath(points));
  const lo = Math.min(...series.map((value) => 100 - value * 3));
  const hi = Math.max(...series.map((value) => 100 - value * 3));
  for (const y of ys) {
    assert.ok(y >= lo - 0.01 && y <= hi + 0.01, `curve left the band at ${y}`);
  }
  // The path runs through every real point.
  for (const [, y] of points) assert.ok(ys.some((sample) => Math.abs(sample - y) < 0.01), `${y} missing`);
});

test('versusPaths shares one percent scale that always holds zero', () => {
  const drawn = versusPaths([null, 0, 20], [null, 0, -10], 300, 150, 10);
  assert.ok(drawn.segment.startsWith('M '));
  assert.ok(drawn.collection.startsWith('M '));
  // +20 above, -10 below, and 0 sits between them on the same scale.
  assert.ok(drawn.zeroY > 10 && drawn.zeroY < 140);
  assert.ok(drawn.last.y < drawn.zeroY);
  assert.deepEqual(drawn.last, { x: 290, y: 10, pct: 20 });
  // Zero is inside the band even when both series only rise.
  const rising = versusPaths([5, 40], [6, 44], 300, 150, 10);
  assert.ok(rising.zeroY > rising.last.y);
  // Nothing but nulls draws nothing.
  assert.deepEqual(versusPaths([null], [null], 300, 150, 10), { segment: '', collection: '', zeroY: 75, last: null });
  // A flat series at zero still gets a band, so the line is not on the edge.
  const flat = versusPaths([0, 0], [0, 0], 300, 150, 10);
  assert.equal(flat.zeroY, 75);
  assert.ok(flat.segment.length > 0);
  // Different lengths: the shorter series still lines up by index.
  const mixed = versusPaths([10, null, 30], [10], 300, 150, 0);
  assert.ok(mixed.collection.length > 0);
  assert.equal(mixed.last.x, 300);
});

/** The first and last point a `smoothPath` draws: its `M` and its last end. */
function pathEnds(d) {
  const numbers = (text) => (text.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
  const commands = d.match(/[MC][^MC]*/g) || [];
  const head = numbers(commands[0]);
  const tail = numbers(commands[commands.length - 1]);
  return {
    first: { x: head[0], y: head[1] },
    last: { x: tail[tail.length - 2], y: tail[tail.length - 1] },
  };
}

test('versusPaths plots each day at its own date in the window', () => {
  const width = 320;
  const pad = 10;
  const days = 10;
  const xOf = (index) => pad + (index / (days - 1)) * (width - pad * 2);
  // The collection has been priced since the 2nd day of the window, the segment
  // only since the 4th: neither line may pretend to start on the 1st.
  const segment = [null, null, null, 0, 3, 2, 6, 5, 9, 12];
  const collection = [null, 0, 1, 2, 1, 3, 2, 4, 3, 5];
  const drawn = versusPaths(segment, collection, width, 150, pad);
  const seg = pathEnds(drawn.segment);
  const coll = pathEnds(drawn.collection);

  assert.ok(Math.abs(seg.first.x - xOf(3)) < 0.01, `segment starts at ${seg.first.x}, wanted ${xOf(3)}`);
  assert.ok(Math.abs(coll.first.x - xOf(1)) < 0.01, `collection starts at ${coll.first.x}, wanted ${xOf(1)}`);
  assert.ok(seg.first.x > coll.first.x, 'a later series must start later, not at the same edge');
  // Nothing at all is drawn for the days before a series has a value.
  for (const x of (drawn.segment.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((_, i) => i % 2 === 0)) {
    assert.ok(x >= xOf(3) - 0.01, `the segment line reaches x ${x}, before its first day`);
  }
  // Both series end on the window's last day, so the labels underneath hold.
  assert.ok(Math.abs(seg.last.x - xOf(9)) < 0.01, `segment ends at ${seg.last.x}`);
  assert.ok(Math.abs(coll.last.x - xOf(9)) < 0.01, `collection ends at ${coll.last.x}`);
  // The end dot sits on the segment's last plotted point.
  assert.ok(Math.abs(drawn.last.x - xOf(9)) < 0.01, `dot at ${drawn.last.x}`);
  assert.ok(Math.abs(drawn.last.y - seg.last.y) < 0.01, `dot at ${drawn.last.y}, line ends at ${seg.last.y}`);
});

test('formatSegmentChange signs, rounds and blanks', () => {
  assert.equal(formatSegmentChange(8.6), '+8.6%');
  assert.equal(formatSegmentChange(-3.24), '-3.2%');
  assert.equal(formatSegmentChange(0), '0.0%');
  assert.equal(formatSegmentChange(-0.02), '0.0%');
  assert.equal(formatSegmentChange(null), '');
  assert.equal(formatSegmentChange(Number.NaN), '');
  assert.equal(formatSegmentChange(200), '+200.0%');
});

/** The book itself: two days of one game, the whole value on each. */
function bookModel() {
  return normalizeSegments(answer([
    { date: '2026-11-16', cardsValuePkn: 1000, segments: { 'game:pokemon': [1000, 9, 30] } },
    { date: '2026-11-17', cardsValuePkn: 1200, segments: { 'game:pokemon': [1200, 9, 30] } },
  ]));
}

/** The saved lists' own model, as `normalizeCollections` hands it over. */
function savedModel() {
  return {
    defs: [
      { key: 'collection:c1', group: 'collection', game: '', label: 'Charizard binder', years: undefined },
      { key: 'collection:c2', group: 'collection', game: '', label: 'Sealed', years: undefined },
    ],
    days: [
      { date: '2026-11-16', cardsValuePkn: null, segments: { 'collection:c1': { valuePkn: 500, priced: 2, held: 3 }, 'collection:c2': { valuePkn: 0, priced: 0, held: 4 } } },
      { date: '2026-11-17', cardsValuePkn: null, segments: { 'collection:c1': { valuePkn: 600, priced: 2, held: 3 }, 'collection:c2': { valuePkn: 0, priced: 0, held: 4 } } },
      { date: '2026-11-18', cardsValuePkn: null, segments: { 'collection:c1': { valuePkn: 660, priced: 2, held: 3 }, 'collection:c2': { valuePkn: 0, priced: 0, held: 4 } } },
    ],
  };
}

test('normalizeSegmentDefs is the def half of normalizeSegments', () => {
  assert.deepEqual(normalizeSegmentDefs(undefined), []);
  assert.deepEqual(normalizeSegmentDefs('junk'), []);
  assert.deepEqual(
    normalizeSegmentDefs([
      { key: 'game:pokemon', group: 'game', game: 'pokemon' },
      { key: 'game:pokemon', group: 'game', game: 'pokemon' },
      { key: 'collection:c1', group: 'collection', label: 'Charizard binder' },
      { key: 'x', group: 'nonsense' },
      { group: 'game' },
    ]),
    [
      { key: 'game:pokemon', group: 'game', game: 'pokemon', label: '', years: undefined },
      { key: 'collection:c1', group: 'collection', game: '', label: 'Charizard binder', years: undefined },
    ],
    'a saved list is a segment like any other, once',
  );
});

test('the Collections level is there whenever a collections model is supplied', () => {
  const book = bookModel();
  assert.deepEqual(segmentLevels(book), [
    { id: 'all', label: 'All games' },
    { id: 'pokemon', label: 'Pokémon' },
  ]);
  // Nothing saved yet still lists it: the level is where the first one is made.
  assert.deepEqual(segmentLevels(withCollections(book, savedModel())).map((level) => level.id), ['all', 'pokemon', COLLECTIONS_LEVEL]);
  assert.deepEqual(segmentLevels(withCollections(book, { defs: [], days: [] })).map((level) => level.id), ['all', 'pokemon', COLLECTIONS_LEVEL]);
  assert.deepEqual(segmentLevels(withCollections(book, null)), segmentLevels(book), 'no answer, no level');
  assert.deepEqual(segmentLevels(withCollections(null, { defs: [], days: [] })).map((level) => level.id), [COLLECTIONS_LEVEL]);
  assert.equal(segmentLevels(withCollections(book, savedModel()))[2].label, 'Collections');
  assert.deepEqual(collectionsModel(book), null);
  assert.equal(collectionsModel(withCollections(book, null)), null);
  assert.deepEqual(collectionsModel(withCollections(book, savedModel())), savedModel());
  assert.equal(withCollections(null, null), null);
  // The saved rows are never a level of their own on another group, and the
  // levels that already existed keep their order.
  const withSets = normalizeSegments(answer(
    [{ date: '2026-11-17', cardsValuePkn: 10, segments: { 'game:riftbound': [10, 1, 1], 'riftbound:set:smoky': [4, 1, 1] } }],
    [
      { key: 'game:pokemon', group: 'game', game: 'pokemon' },
      { key: 'game:riftbound', group: 'game', game: 'riftbound' },
      { key: 'riftbound:set:smoky', group: 'set', game: 'riftbound', label: 'Smoky' },
    ],
  ));
  assert.deepEqual(
    segmentLevels(withCollections(withSets, savedModel())).map((level) => level.id),
    ['all', 'riftbound', COLLECTIONS_LEVEL],
  );
});

test('the Collections level is one group of the saved rows', () => {
  const model = withCollections(bookModel(), savedModel());
  const groups = segmentGroups(model, COLLECTIONS_LEVEL, {});
  assert.deepEqual(groups.map((group) => group.title), ['Collections']);
  assert.deepEqual(groups[0].rows.map((row) => row.label), ['Charizard binder', 'Sealed']);
  const binder = groups[0].rows[0];
  assert.equal(binder.key, 'collection:c1');
  assert.deepEqual(binder.series.map((point) => [point.date, point.valuePkn]), [
    ['2026-11-16', 500],
    ['2026-11-17', 600],
    ['2026-11-18', 660],
  ]);
  assert.equal(binder.valuePkn, 660);
  assert.equal(binder.held, 3, 'the cards of the list, not of the book');
  assert.equal(binder.priced, 2);
  assert.equal(binder.sub, '', 'a saved list carries no years line');
  // The window is the same one the other levels use, and it cuts the saved days too.
  const week = segmentGroups(model, COLLECTIONS_LEVEL, { from: '2026-11-17', to: '2026-11-18' })[0].rows[0];
  assert.deepEqual(week.series.map((point) => point.valuePkn), [600, 660]);
  assert.equal(week.changePct, 10);
  // A list with nothing priced in it is a row of its own state, not a hole.
  const sealed = groups[0].rows[1];
  assert.equal(sealed.state, 'unpriced');
  assert.equal(sealed.held, 4);
  assert.equal(segmentGroups(withCollections(bookModel(), { defs: [], days: [] }), COLLECTIONS_LEVEL, {}).length, 0);
  assert.equal(segmentGroups(withCollections(bookModel(), null), COLLECTIONS_LEVEL, {}).length, 0);
});

test('the saved rows never leak into the levels that already existed', () => {
  const model = withCollections(bookModel(), savedModel());
  for (const level of ['all', 'pokemon']) {
    const keys = segmentGroups(model, level, {}).flatMap((group) => group.rows.map((row) => row.key));
    assert.ok(!keys.some((key) => key.startsWith('collection:')), `${level} lists only its own rows`);
  }
  // And the level the table opens on stays the book's own.
  assert.equal(defaultSegmentLevel(model), defaultSegmentLevel(bookModel()));
});

test('a collection chart compares with the book value of its own days', () => {
  const model = withCollections(bookModel(), savedModel());
  const row = segmentGroups(model, COLLECTIONS_LEVEL, {})[0].rows[0];
  // Matched by date, so the extra day the saved list has does not shift the
  // dashed line, and a day the book never priced stays unknown instead of 0.
  assert.deepEqual(collectionSeriesOn(model, row.series), [
    { date: '2026-11-16', valuePkn: 1000 },
    { date: '2026-11-17', valuePkn: 1200 },
    { date: '2026-11-18', valuePkn: null },
  ]);
  assert.deepEqual(indexedSeries(collectionSeriesOn(model, row.series)), [0, 20, null]);
  assert.deepEqual(collectionSeriesOn(model, []), []);
  assert.deepEqual(collectionSeriesOn(null, row.series).map((point) => point.valuePkn), [null, null, null]);
  // The other levels keep comparing with the windowed book, as before.
  assert.deepEqual(collectionSeries(model, { from: '2026-11-17', to: '' }).map((point) => point.valuePkn), [1200]);
});

test('the saved lists join the table after the history, whichever answered first', () => {
  const lists = savedModel();
  // The lists answered while the history read is still out: there is no model at
  // all, so the table keeps its skeleton and has no level to open on.
  assert.equal(joinedSegments({ history: null, pending: true, collections: lists }), null);
  // A split that is already on screen paints while a fresh one is out; the lists
  // just wait for it.
  assert.deepEqual(joinedSegments({ history: bookModel(), pending: true, collections: lists }).defs,
    bookModel().defs, 'the book paints what it has');
  // The history answers with its split: the lists nest inside it.
  const joined = joinedSegments({ history: bookModel(), pending: false, collections: lists });
  assert.deepEqual(segmentLevels(joined).map((level) => level.id), ['all', 'pokemon', COLLECTIONS_LEVEL]);
  assert.equal(defaultSegmentLevel(joined), defaultSegmentLevel(bookModel()), 'the history still picks the opening level');
  // The history is over and brought no split at all — an answer without one, or
  // a read that failed: the seller's own lists are the whole table now.
  const alone = joinedSegments({ history: null, pending: false, collections: lists });
  assert.deepEqual(segmentLevels(alone).map((level) => level.id), [COLLECTIONS_LEVEL]);
  assert.equal(defaultSegmentLevel(alone), COLLECTIONS_LEVEL);
  assert.equal(segmentGroups(alone, COLLECTIONS_LEVEL, {}).flatMap((group) => group.rows).length, 2);
  // Nothing answered on either side: nothing to draw.
  assert.equal(joinedSegments({ history: null, pending: false, collections: null }), null);
  assert.equal(joinedSegments(), null);
});
