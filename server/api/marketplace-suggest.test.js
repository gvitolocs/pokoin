'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler } = require('./marketplace-suggest');
const { attachExpansionNationality, resetExpansionNationalityCache } = require('./_expansion_nationality');

const hits = Array.from({ length: 170 }, (_, i) => ({
  card_id: String(800000 + i), name: 'Dialga', name_group: 'Dialga',
  set_name: i < 150 ? 'Western Set' : 'Japanese Set', card_number: `${i + 1}/200`,
  // The old indexed facet knows only the first Western card.
  nationality: i === 0 ? 'western' : '', _rankingScore: 1,
}));
const rows = (body) => body.groups.flatMap((group) => group.printings);
function response() {
  return { statusCode: 200, body: null, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, end() { return this; } };
}
async function invoke(query) {
  const calls = [];
  const handler = createHandler({
    meiliConfigured: () => true, useMeiliSearchForLanguage: () => true,
    marketplaceQuery: async () => ({ rows: [] }), rememberHotSuggestQuery: () => {},
    attachTitleLanguageOnGroups: async (groups) => groups,
    attachExpansionNationality: async (groups) => groups.map((group) => ({ ...group,
      printings: group.printings.map((row) => ({ ...row,
        nationality: row.set === 'Western Set' ? 'western' : 'japanese' })),
    })),
    meiliMarketplaceSuggestHits: async (q, lang, limit, options) => {
      calls.push({ q, lang, limit, options });
      const filtered = options.printLanguage === 'western';
      return { hits: (filtered ? hits.slice(0, 1) : hits).slice(0, limit),
        estimatedTotalHits: filtered ? 1 : hits.length, printFilterApplied: filtered };
    },
  });
  const res = response();
  await handler({ method: 'GET', headers: { host: 'pokoin.com' },
    url: `/api/marketplace-suggest?q=Dialga&${query}` }, res);
  assert.equal(res.statusCode, 200);
  return { body: res.body, calls };
}

test('candidate hydration returns the full bounded name bucket before the popup cap', async () => {
  const { body, calls } = await invoke('hydrate=1&limit=1000&print_language=all');
  assert.equal(rows(body).length, 170);
  assert.equal(body.count, 170);
  assert.equal(body.exhaustive, true);
  assert.equal(body.hydrated, true);
  assert.equal(calls[0].limit, 1000);
  assert.equal(calls[0].options.printLanguage, 'all');
});

test('Western uses hydrated nationality instead of the incomplete indexed facet', async () => {
  const { body, calls } = await invoke('print_language=western');
  assert.equal(rows(body).length, 20, 'only the final response has the popup cap');
  assert.equal(body.count, 150, 'the count includes matching printings beyond twenty');
  assert.ok(rows(body).every((row) => row.nationality === 'western'));
  assert.equal(calls[0].options.printLanguage, 'all');
});

test('legacy All clients retain twenty rows while hydration is explicitly bounded', async () => {
  const legacy = await invoke('limit=1000&print_language=all');
  assert.equal(rows(legacy.body).length, 20);
  assert.equal(legacy.body.hydrated, false);
  const hydrate = await invoke('hydrate=1&limit=999999&print_language=all');
  assert.equal(hydrate.body.candidateLimit, 1000);
  assert.ok(rows(hydrate.body).length <= 1000);
});

test('progressive suggest pages by offset instead of a 1000-row ceiling', async () => {
  const { body, calls } = await invoke('progressive=1&hydrate=1&limit=50&offset=50&print_language=all');
  assert.equal(calls[0].limit, 50);
  assert.equal(calls[0].options.offset, 50);
  assert.equal(body.offset, 50);
  assert.equal(body.candidateLimit, 50);
  assert.equal(body.exhaustive, false);
  assert.ok(rows(body).length <= 50);
});

test('an unknown indexed nationality hydrates from the catalog without overwriting known prints', async () => {
  resetExpansionNationalityCache();
  const groups = await attachExpansionNationality([{ name: 'Dialga', printings: [
    { id: 'unknown', name: 'Dialga', set: 'Known Set', nationality: 'unknown' },
    { id: 'known', name: 'Dialga', set: 'Known Set', nationality: 'japanese' },
    { id: 'missing', name: 'Dialga', set: 'Unmapped Set', nationality: '' },
  ] }], async () => ({ rows: [{ name: 'Known Set', nationality: 'western' }] }));
  assert.deepEqual(groups[0].printings.map((row) => row.nationality), ['western', 'japanese', '']);
});
