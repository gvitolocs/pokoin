import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSuggestRanked } from './suggest-rank.js';
import { resolveSuggestQuery } from './suggest-resolve.js';
import {
  liveSuggestGroups,
  rememberSuggestGroups,
  resetSuggestLive,
} from './suggest-live.js';

// Real compound catalog cards. The SUGGEST endpoint (name-relevance) omits the
// compound for a `<species> <mechanic>` query — reproduced live on
// api.pokoin.com — while the full-text SEARCH endpoint returns it. These mocks
// mirror that asymmetry so the test proves candidate generation no longer
// depends on which pipeline a recognized token would have chosen.
const COMPOUND = {
  'pikachu gx': { id: '259178', name: 'Pikachu & Zekrom GX', set: 'Team Up', rarity: 'Rare Holo GX', number: '33/181', nationality: 'western' },
  'palkia legend': { id: '9001', name: 'Palkia & Dialga LEGEND', set: 'HS Triumphant', rarity: 'LEGEND', number: '101/102', nationality: 'western' },
  'reshiram gx': { id: '9002', name: 'Reshiram & Charizard GX', set: 'Unbroken Bonds', rarity: 'Rare Holo GX', number: '20/214', nationality: 'western' },
  'espeon gx': { id: '9003', name: 'Espeon & Deoxys GX', set: 'Unified Minds', rarity: 'Rare Holo GX', number: '72/236', nationality: 'western' },
  'arceus gx': { id: '9004', name: 'Arceus & Dialga & Palkia GX', set: 'Cosmic Eclipse', rarity: 'Rare Holo GX', number: '156/236', nationality: 'western' },
};
// A plain single that suggest DOES return (and the species base).
const PLAIN = (species) => ({ id: `plain-${species}`, name: species[0].toUpperCase() + species.slice(1), set: 'Base Set', rarity: 'Common', number: '019/068', nationality: 'western' });

function makeEndpoints() {
  const calls = { suggest: [], search: [] };
  // SUGGEST: name-relevance, never returns the compound for these queries.
  const fetchSuggest = async (q) => {
    calls.suggest.push(q);
    return { groups: [{ name: 'Pikachu', printings: [PLAIN('pikachu')] }], count: 500 };
  };
  // SEARCH: high recall — returns the compound for the raw query.
  const fetchSearch = async ({ query }) => {
    calls.search.push(query);
    const key = String(query || '').toLowerCase().trim();
    const compound = COMPOUND[key];
    const cards = [];
    if (compound) {
      cards.push(compound);
    }
    cards.push(PLAIN(key.split(' ')[0] || 'pikachu'));
    return { cards, total: 1211 };
  };
  return { calls, fetchSuggest, fetchSearch };
}

async function hydrate(query, endpoints, opts = {}) {
  return fetchSuggestRanked(query, {
    fetchSuggest: endpoints.fetchSuggest,
    fetchSearch: endpoints.fetchSearch,
    limit: 20,
    lang: 'en',
    printLang: 'all',
    kind: 'singles',
    resolved: resolveSuggestQuery(query),
    ...opts,
  });
}

const groupNames = (data) => (data.hydrated || data.groups || []).map((g) => g.name);

// --- §10 / §12: the candidate layer is symmetric ------------------------------

test('candidate generation uses the SEARCH endpoint for BOTH set-homonym and mechanic compounds', async () => {
  for (const query of ['pikachu gx', 'palkia legend']) {
    const ep = makeEndpoints();
    const data = await hydrate(query, ep);
    // Both must hit the high-recall SEARCH endpoint (not one SEARCH, one SUGGEST).
    assert.ok(ep.calls.search.length > 0, `${query} must query the SEARCH endpoint`);
    // And the compound must be in the hydrated candidate union.
    assert.ok(groupNames(data).includes(COMPOUND[query].name),
      `${query}: candidate union must contain ${COMPOUND[query].name}`);
  }
});

test('regression guard: a mechanic query must not be starved of the SEARCH endpoint', async () => {
  // Fails if someone reintroduces setAware→SEARCH / non-set→SUGGEST-only.
  const ep = makeEndpoints();
  await hydrate('pikachu gx', ep);
  assert.ok(ep.calls.search.some((q) => /pikachu gx/i.test(q)),
    'pikachu gx must be sent to the full-text SEARCH endpoint');
});

test('the first query word no longer seeds hydration (no plain-Pikachu fan-out)', async () => {
  const ep = makeEndpoints();
  await hydrate('pikachu gx', ep);
  // Old bug: suggest lookups were "Pikachu", "Pikachu Libre", … from the first
  // word. Free text now leans on SEARCH; no first-word variant fan-out.
  const variantFanout = ep.calls.suggest.filter((q) => /^pikachu .+/i.test(q) && !/gx/i.test(q));
  assert.equal(variantFanout.length, 0, `unexpected first-word fan-out: ${variantFanout.join(', ')}`);
});

// --- §11: other real compounds -----------------------------------------------

test('every real compound card reaches the candidate union through the generic path', async () => {
  for (const [query, card] of Object.entries(COMPOUND)) {
    const ep = makeEndpoints();
    const data = await hydrate(query, ep);
    assert.ok(groupNames(data).includes(card.name), `${query} → ${card.name} must be in the union`);
  }
});

// --- §16: palkia legend no longer needs the setAware rescue -------------------

test('palkia legend reaches the compound via the generic search query, not a set filter', async () => {
  const ep = makeEndpoints();
  await hydrate('palkia legend', ep);
  // The generic path searches the RAW query — not a Call-of-Legends set filter.
  assert.ok(ep.calls.search.some((q) => /palkia legend/i.test(q)),
    'palkia legend must search the raw query through the generic high-recall path');
});

test('single-token autocomplete stays on SUGGEST (no heavy SEARCH per keystroke)', async () => {
  const ep = makeEndpoints();
  await hydrate('pikachu', ep);
  assert.equal(ep.calls.search.length, 0, 'one-token typing should not hit the SEARCH endpoint');
  assert.ok(ep.calls.suggest.length > 0);
});

// --- End-to-end: hydration → cache → unified scorer ---------------------------

test('after hydration the unified scorer ranks the compound #2, above plain Pikachu', async () => {
  const ep = makeEndpoints();
  const data = await hydrate('pikachu gx', ep);
  resetSuggestLive();
  // The popup remembers what the hydration produced, then scores the cache.
  rememberSuggestGroups(data.hydrated || data.groups);
  // Add the exact-name winner + a plain Pikachu the way real hydration would.
  rememberSuggestGroups([
    { name: 'Pikachu GX', printings: [{ id: '476514', name: 'Pikachu GX', set: 'SM Promos', rarity: 'Rare Holo GX', number: 'SM232', nationality: 'western' }] },
  ]);
  const live = liveSuggestGroups('pikachu gx', { preferPerGroup: 4 });
  const names = live.groups.map((g) => g.name);
  assert.equal(names[0], 'Pikachu GX', 'exact form ranks first');
  assert.ok(names.includes('Pikachu & Zekrom GX'), 'Tag Team is present');
  assert.ok(names.indexOf('Pikachu & Zekrom GX') < names.indexOf('Pikachu'),
    'Tag Team (2/2) ranks above plain Pikachu (1/2)');
});
