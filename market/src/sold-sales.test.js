import assert from 'node:assert/strict';
import test from 'node:test';
import { soldFilterShowsAll, soldFilterValue } from './sold-graph.js';
import { soldGraphView, soldTraitsForGraphDay, sharedSoldTraits } from './sold-sales.js';

const LEDIAN = [
  {
    day: '2026-09-01',
    condition: 'NM',
    language: 'EN',
    reverse: false,
    firstEdition: false,
    graded: false,
    medianPkn: 10,
    soldQty: 9,
    listings: 9,
    sampleCount: 9,
  },
  {
    day: '2026-09-01',
    condition: 'Poor',
    language: 'IT',
    reverse: false,
    firstEdition: false,
    graded: false,
    medianPkn: 2,
    soldQty: 1,
    listings: 1,
    sampleCount: 1,
  },
];

test('sold graph All languages keeps every language on the printing', () => {
  const view = soldGraphView(LEDIAN, {});
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.deepEqual(view.filters.conditions, ['NM', 'Poor']);
  assert.equal(view.series.sampleCount, 10);
  assert.equal(view.series.soldQty, 10);
});

test('Poor Italian slice keeps the full card language pool', () => {
  const view = soldGraphView(LEDIAN, { condition: 'Poor', language: 'IT' });
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.deepEqual(view.filters.conditions, ['NM', 'Poor']);
  assert.equal(view.series.sampleCount, 1);
  assert.equal(view.series.days[0].medianPkn, 2);
});

function sale(row) {
  return {
    reverse: false,
    firstEdition: false,
    graded: false,
    soldQty: 1,
    listings: 1,
    sampleCount: 1,
    medianPkn: 10,
    ...row,
  };
}

const DESK = [
  sale({ day: '2026-09-01', condition: 'NM', language: 'EN', medianPkn: 100, soldQty: 4, sampleCount: 4 }),
  sale({ day: '2026-09-01', condition: 'Poor', language: 'IT', medianPkn: 20 }),
  sale({ day: '2026-09-08', condition: 'NM', language: 'EN', reverse: true, medianPkn: 546 }),
  sale({ day: '2026-09-08', condition: 'SP', language: 'EN', firstEdition: true, medianPkn: 80 }),
  sale({ day: '2026-09-08', condition: 'MP', language: 'IT', graded: true, medianPkn: 40 }),
  sale({ day: '2026-09-08', condition: 'NM', language: 'IT', reverse: true, firstEdition: true, medianPkn: 90 }),
];

test('Reverse off plots standard copies only, Reverse on keeps reverse holos only', () => {
  const slices = [
    sale({ day: '2026-09-02', condition: 'NM', language: 'EN', medianPkn: 8, sampleCount: 4, soldQty: 4 }),
    sale({ day: '2026-09-02', condition: 'NM', language: 'EN', reverse: true, medianPkn: 12, sampleCount: 2, soldQty: 2 }),
  ];
  const off = soldGraphView(slices, { reverse: false });
  assert.equal(off.series.sampleCount, 4);
  assert.equal(off.series.lastMedianPkn, 8);
  assert.equal(off.flags.reverse, false);
  const on = soldGraphView(slices, { reverse: true });
  assert.equal(on.series.sampleCount, 2);
  assert.equal(on.series.lastMedianPkn, 12);
  assert.equal(on.flags.reverse, true);
  assert.deepEqual(on.filters.languages, ['EN']);
  assert.deepEqual(on.filters.conditions, ['NM']);
});

test('one reverse Near Mint unit shows Near Mint, not All conditions', () => {
  const view = soldGraphView(DESK, { reverse: true });
  assert.equal(view.series.soldQty, 1);
  assert.deepEqual(view.filters.conditions, ['NM']);
  assert.equal(soldFilterShowsAll(view.filters.conditions), false);
  assert.equal(soldFilterValue(view.filters.conditions, ''), 'NM');
  assert.deepEqual(view.filters.languages, ['EN']);
  assert.equal(soldFilterShowsAll(view.filters.languages), false);
});

test('Reverse with two conditions keeps All conditions for those keys only', () => {
  const slices = [
    sale({ day: '2026-09-02', condition: 'Poor', language: 'EN', medianPkn: 3 }),
    sale({ day: '2026-09-02', condition: 'NM', language: 'EN', reverse: true, medianPkn: 12 }),
    sale({ day: '2026-09-03', condition: 'SP', language: 'IT', reverse: true, medianPkn: 9 }),
  ];
  const view = soldGraphView(slices, { reverse: true });
  assert.deepEqual(view.filters.conditions, ['NM', 'SP']);
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.equal(soldFilterShowsAll(view.filters.conditions), true);
  assert.equal(soldFilterValue(view.filters.conditions, ''), '');
  assert.equal(view.series.soldQty, 2);
});

test('1st Ed. lists only 1st-edition languages and conditions', () => {
  const view = soldGraphView(DESK, { firstEdition: true });
  assert.deepEqual(view.filters.languages, ['EN']);
  assert.deepEqual(view.filters.conditions, ['SP']);
  assert.equal(view.series.soldQty, 1);
});

test('Graded with one Italian MP sale shows Italiano and Moderately Played', () => {
  const view = soldGraphView(DESK, { graded: true });
  assert.deepEqual(view.filters.languages, ['IT']);
  assert.deepEqual(view.filters.conditions, ['MP']);
  assert.equal(soldFilterShowsAll(view.filters.languages), false);
  assert.equal(soldFilterValue(view.filters.conditions, ''), 'MP');
  assert.equal(view.series.soldQty, 1);
});

test('Reverse plus 1st Ed. keeps only the intersecting sale', () => {
  const view = soldGraphView(DESK, { reverse: true, firstEdition: true });
  assert.deepEqual(view.filters.languages, ['IT']);
  assert.deepEqual(view.filters.conditions, ['NM']);
  assert.equal(view.series.soldQty, 1);
  assert.equal(view.series.lastMedianPkn, 90);
});

test('Reverse plus Graded with no overlap keeps printing menus and an empty series', () => {
  const view = soldGraphView(DESK, { reverse: true, graded: true });
  assert.equal(view.series.sampleCount, 0);
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.deepEqual(view.filters.conditions, ['NM', 'SP', 'MP', 'Poor']);
});

test('Poor on the standard slice keeps the printing languages', () => {
  const view = soldGraphView(DESK, { condition: 'Poor' });
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.deepEqual(view.filters.conditions, ['NM', 'Poor']);
  assert.equal(view.series.soldQty, 1);
});

test('turning Reverse off plots the standard slices with their menus', () => {
  const on = soldGraphView(DESK, { reverse: true });
  const off = soldGraphView(DESK, { reverse: false });
  assert.equal(soldFilterValue(on.filters.conditions, ''), 'NM');
  assert.equal(on.series.soldQty, 1);
  assert.deepEqual(off.filters.conditions, ['NM', 'Poor']);
  assert.deepEqual(off.filters.languages, ['EN', 'IT']);
  assert.equal(off.series.soldQty, 5);
  assert.equal(off.flags.reverse, false);
});

test('a reverse-only printing snaps Reverse on so the graph never blanks', () => {
  const slices = [
    sale({ day: '2026-09-02', condition: 'NM', language: 'EN', reverse: true, medianPkn: 12, sampleCount: 2, soldQty: 2 }),
  ];
  const view = soldGraphView(slices, { reverse: false });
  assert.equal(view.flags.reverse, true);
  assert.equal(view.series.sampleCount, 2);
  assert.equal(view.series.lastMedianPkn, 12);
});

test('Reverse requested on a printing without reverse comps snaps back to standard', () => {
  const view = soldGraphView(LEDIAN, { reverse: true });
  assert.equal(view.flags.reverse, false);
  assert.equal(view.series.sampleCount, 10);
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.deepEqual(view.filters.conditions, ['NM', 'Poor']);
});

test('one 1st Ed. Slightly Played sale shows that condition, not All', () => {
  const view = soldGraphView([
    sale({ day: '2026-09-01', condition: 'NM', language: 'EN' }),
    sale({ day: '2026-09-08', condition: 'SP', language: 'EN', firstEdition: true, medianPkn: 80 }),
  ], { firstEdition: true });
  assert.deepEqual(view.filters.languages, ['EN']);
  assert.deepEqual(view.filters.conditions, ['SP']);
  assert.equal(soldFilterValue(view.filters.conditions, ''), 'SP');
  assert.equal(view.series.soldQty, 1);
});

test('Reverse on ignores a leftover Poor selection when reverse is only Near Mint', () => {
  const view = soldGraphView(DESK, { reverse: true, condition: 'Poor' });
  assert.deepEqual(view.filters.conditions, ['NM']);
  assert.equal(view.series.soldQty, 1);
});

test('all three foil toggles with no overlap keep printing menus', () => {
  const view = soldGraphView(DESK, { reverse: true, firstEdition: true, graded: true });
  assert.equal(view.series.sampleCount, 0);
  assert.deepEqual(view.filters.languages, ['EN', 'IT']);
  assert.deepEqual(view.filters.conditions, ['NM', 'SP', 'MP', 'Poor']);
});

test('clicking one reverse Near Mint unit keeps that reverse condition menu', () => {
  const slices = [
    sale({ day: '2026-09-01', condition: 'Poor', language: 'IT' }),
    sale({ day: '2026-09-08', condition: 'NM', language: 'EN', reverse: true, medianPkn: 546 }),
  ];
  const traits = soldTraitsForGraphDay(slices, { reverse: true }, '2026-09-08');
  assert.deepEqual(traits, {
    condition: 'NM',
    language: 'EN',
    reverse: true,
    firstEdition: false,
    graded: false,
  });
  const view = soldGraphView(slices, traits);
  assert.deepEqual(view.filters.conditions, ['NM']);
  assert.deepEqual(view.filters.languages, ['EN']);
  assert.equal(soldFilterShowsAll(view.filters.conditions), false);
});

test('Japanese printings drop western languages from cached slices', () => {
  const view = soldGraphView([
    {
      day: '2026-09-03',
      condition: 'NM',
      language: 'EN',
      reverse: false,
      firstEdition: false,
      graded: false,
      medianPkn: 5,
      sampleCount: 3,
    },
    {
      day: '2026-09-03',
      condition: 'NM',
      language: 'JP',
      reverse: false,
      firstEdition: false,
      graded: false,
      medianPkn: 7,
      sampleCount: 8,
    },
  ], { nationality: 'japanese' });
  assert.deepEqual(view.filters.languages, ['JP']);
  assert.equal(view.series.sampleCount, 8);
});

test('units follow sold copies when one listing removes several cards', () => {
  const view = soldGraphView([{
    day: '2026-09-02',
    condition: 'NM',
    language: 'IT',
    reverse: false,
    firstEdition: false,
    graded: false,
    medianPkn: 34,
    soldQty: 8,
    listings: 2,
    sampleCount: 2,
  }]);
  assert.equal(view.series.sampleCount, 2);
  assert.equal(view.series.soldQty, 8);
});

test('one unit on a day aligns every graph menu to that sale', () => {
  const traits = soldTraitsForGraphDay([{
    day: '2026-09-10',
    condition: 'NM',
    language: 'IT',
    reverse: true,
    firstEdition: false,
    graded: false,
    medianPkn: 546,
    soldQty: 1,
    listings: 1,
    sampleCount: 1,
  }], {}, '2026-09-10');
  assert.deepEqual(traits, {
    condition: 'NM',
    language: 'IT',
    reverse: true,
    firstEdition: false,
    graded: false,
  });
});

test('shared traits on a mixed day keep only unanimous keys', () => {
  const slices = [
    {
      day: '2026-09-10',
      condition: 'NM',
      language: 'EN',
      reverse: true,
      firstEdition: false,
      graded: false,
      medianPkn: 12,
      soldQty: 2,
      listings: 1,
      sampleCount: 1,
    },
    {
      day: '2026-09-10',
      condition: 'NM',
      language: 'IT',
      reverse: true,
      firstEdition: false,
      graded: false,
      medianPkn: 11,
      soldQty: 1,
      listings: 1,
      sampleCount: 1,
    },
  ];
  assert.deepEqual(soldTraitsForGraphDay(slices, {}, '2026-09-10'), {
    condition: 'NM',
    language: '',
    reverse: true,
    firstEdition: false,
    graded: false,
  });
});

test('graph click uses the currently visible slice, not hidden languages', () => {
  const slices = [
    {
      day: '2026-09-10',
      condition: 'NM',
      language: 'EN',
      reverse: false,
      firstEdition: false,
      graded: false,
      medianPkn: 10,
      soldQty: 1,
      listings: 1,
      sampleCount: 1,
    },
    {
      day: '2026-09-10',
      condition: 'Poor',
      language: 'IT',
      reverse: false,
      firstEdition: false,
      graded: false,
      medianPkn: 2,
      soldQty: 1,
      listings: 1,
      sampleCount: 1,
    },
  ];
  assert.deepEqual(soldTraitsForGraphDay(slices, { language: 'EN' }, '2026-09-10'), {
    condition: 'NM',
    language: 'EN',
    reverse: false,
    firstEdition: false,
    graded: false,
  });
});

test('a mixed reverse day keeps the standard default', () => {
  assert.deepEqual(sharedSoldTraits([
    { condition: 'NM', language: 'EN', reverse: true, firstEdition: false, graded: false },
    { condition: 'NM', language: 'EN', reverse: false, firstEdition: false, graded: false },
  ]), {
    condition: 'NM',
    language: 'EN',
    reverse: false,
    firstEdition: false,
    graded: false,
  });
});
