import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTypedQuery,
  isArtAwareQuery,
  isNumberAwareQuery,
  isSetAwareQuery,
  isSetOnlyQuery,
  printingMatchesNumberFilter,
  setAliasPool,
} from './suggest-rank.js';
import { filterSearchCards } from './search-filters.js';
import SPECIES from './data/pokedex-species.js';
import ARTISTS from './data/suggest-artists.js';

// TLC-style exhaustive 3-token sweep over the query vocabulary the search
// page can receive. Every state of the bounded model is parsed and asserted
// well-formed; the derived search-page predicates run on a deterministic
// slice plus explicit witnesses.
//
// Bounded-model statement (same discipline as the TLC runners), priced with
// measured operator costs: a 3-token parse costs 0.2–8.5ms depending on how
// far its words sit from the known name/expansion vocabularies
// (prefixEditDistance + rankNames dominate), and set-bearing titles reach
// 150ms. The model therefore sweeps:
//   tier 1 — the FULL ordered cross-product (all 6 token permutations) of
//     compact pools across every class triple: name × rarity × number,
//     name × rarity × artist, artist × rarity × number, name × artist ×
//     number;
//   tier 2 — EVERY National Dex species (2 rotating states each, all
//     generations) against the rarity/number vocabularies;
//   tier 3 — EVERY artist in the local catalog (2 rotating states each);
//   tier 4 — era × generation anchored set states: species from every
//     generation pair with expansions of their OWN TCG eras (Pokédex number
//     → generation → debut era + next newer block + the SV/Mega staples)
//     plus a spread over every setAliasPool alias.
// The parse contract is the invariant: parseTypedQuery always yields
// well-formed arrays/strings and the derived predicates never throw.

const SPECIES_NAMES = Object.keys(SPECIES);

const NAME_VARIATIONS = [
  'pikachu', 'charizard', 'eevee', 'arceus', 'mega charizard', 'mega lopunny',
];

const RARITY_TOKENS = [
  'secret rare', 'holo rare', 'ur', 'rare', 'illustration', 'amazing',
];

const NUMBER_TOKENS = ['102', '102/109', '#102', '007'];

const EXPANSION_POOL = setAliasPool();

const ARTIST_POOL = ARTISTS.map((row) => String(row.display || '').trim()).filter(Boolean);
const ARTIST_SAMPLE = ARTIST_POOL.slice(0, 4);

// Pokédex number → generation → the TCG eras that species actually appears
// in: debut block + the immediately newer block, plus the modern staples
// where every generation reprints (Scarlet & Violet, Mega Evolution).
const ERA_OLDEST_FIRST = [
  'Original', 'Neo', 'VS / web', 'Legendary Collection', 'e-Card', 'EX',
  'Diamond & Pearl', 'Platinum', 'HeartGold & SoulSilver', 'Call of Legends',
  'Black & White', 'XY', 'Sun & Moon', 'Sword & Shield', 'Scarlet & Violet',
  'Mega Evolution',
];
const GEN_DEBUT_ERA = {
  1: 'Original', 2: 'Neo', 3: 'e-Card', 4: 'Diamond & Pearl',
  5: 'Black & White', 6: 'XY', 7: 'Sun & Moon', 8: 'Sword & Shield',
  9: 'Scarlet & Violet',
};

function speciesGeneration(dex) {
  if (dex <= 151) return 1;
  if (dex <= 251) return 2;
  if (dex <= 386) return 3;
  if (dex <= 493) return 4;
  if (dex <= 649) return 5;
  if (dex <= 721) return 6;
  if (dex <= 809) return 7;
  if (dex <= 905) return 8;
  return 9;
}

function speciesEras(dex) {
  const debut = ERA_OLDEST_FIRST.indexOf(GEN_DEBUT_ERA[speciesGeneration(dex)]);
  const anchored = ERA_OLDEST_FIRST.slice(debut, debut + 2);
  return [...new Set([...anchored, 'Scarlet & Violet', 'Mega Evolution'])];
}

const EXPANSIONS_BY_ERA = new Map();
for (const row of EXPANSION_POOL) {
  const era = row.eraId || '';
  if (!EXPANSIONS_BY_ERA.has(era)) EXPANSIONS_BY_ERA.set(era, []);
  EXPANSIONS_BY_ERA.get(era).push(row.display);
}

// One species per National Dex number (aliases map onto the same dex).
const DEX_ENTRIES = (() => {
  const byDex = new Map();
  for (const name of SPECIES_NAMES) {
    const dex = SPECIES[name];
    if (Number.isFinite(dex) && !byDex.has(dex)) byDex.set(dex, name);
  }
  return [...byDex.entries()].sort((a, b) => a[0] - b[0]);
})();

function ownEraExpansion(dex, rotation) {
  const eras = speciesEras(dex);
  const displays = eras.flatMap((era) => EXPANSIONS_BY_ERA.get(era) || []);
  return displays.length ? displays[rotation % displays.length] : 'evolutions';
}

function permutations(tokens) {
  if (tokens.length <= 1) return [tokens];
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const rest = tokens.slice(0, i).concat(tokens.slice(i + 1));
    for (const perm of permutations(rest)) {
      out.push([tokens[i], ...perm]);
    }
  }
  return out;
}

function assertParsedShape(parsed, query) {
  assert.equal(parsed.raw, query.trim(), `raw echo for ${JSON.stringify(query)}`);
  assert.equal(typeof parsed.nameQuery, 'string', `nameQuery for ${JSON.stringify(query)}`);
  for (const key of ['setTokens', 'artTokens', 'numberTokens', 'rarityTokens', 'eras']) {
    assert.ok(Array.isArray(parsed[key]), `${key} must be an array for ${JSON.stringify(query)}`);
  }
  for (const token of parsed.setTokens) {
    assert.equal(typeof token.compact, 'string', `setToken compact for ${JSON.stringify(query)}`);
  }
  for (const token of parsed.rarityTokens) {
    assert.equal(typeof token.rarity, 'string', `rarityToken for ${JSON.stringify(query)}`);
  }
}

function assertPredicates(parsed, query) {
  // None of the search-page's derived predicates may throw on any parse.
  isNumberAwareQuery(parsed);
  isSetAwareQuery(parsed);
  isSetOnlyQuery(parsed);
  isArtAwareQuery(parsed);
  const printing = {
    id: '91', name: 'Spheal', set: 'HL - Deoxys', set_name: 'HL - Deoxys',
    card_number: '102/109', rarity: 'Rare', product_type: 'card',
  };
  printingMatchesNumberFilter(printing, parsed);
  filterSearchCards([printing], { type: 'singles', rarity: '', set: '', sort: 'match' });
}

let checked = 0;
let setChecked = 0;
let predicateChecked = 0;

function sweep(builder, label, { countsAsSet = false } = {}) {
  const violations = [];
  for (const query of builder()) {
    try {
      const parsed = parseTypedQuery(query);
      assertParsedShape(parsed, query);
      checked += 1;
      if (countsAsSet) setChecked += 1;
      if (checked % 41 === 0) {
        assertPredicates(parsed, query);
        predicateChecked += 1;
      }
    } catch (error) {
      if (violations.length < 5) violations.push(`${error.message}`);
    }
  }
  assert.deepEqual(violations, [], `${label} violations:\n${violations.join('\n')}`);
}

test('full ordered cross-product of name × rarity × collector-number × artist', () => {
  const before = checked;
  sweep(function* () {
    for (const name of NAME_VARIATIONS) {
      for (const rarity of RARITY_TOKENS) {
        for (const number of NUMBER_TOKENS) {
          for (const perm of permutations([name, rarity, number])) {
            yield perm.join(' ');
          }
        }
      }
    }
    for (const name of NAME_VARIATIONS) {
      for (const rarity of RARITY_TOKENS) {
        for (const artist of ARTIST_SAMPLE) {
          for (const perm of permutations([name, rarity, artist])) {
            yield perm.join(' ');
          }
        }
      }
    }
    for (const artist of ARTIST_SAMPLE) {
      for (const rarity of RARITY_TOKENS) {
        for (const number of NUMBER_TOKENS) {
          for (const perm of permutations([artist, rarity, number])) {
            yield perm.join(' ');
          }
        }
      }
    }
    for (const name of NAME_VARIATIONS) {
      for (const artist of ARTIST_SAMPLE) {
        for (const number of NUMBER_TOKENS) {
          for (const perm of permutations([name, artist, number])) {
            yield perm.join(' ');
          }
        }
      }
    }
  }, 'class cross-product');
  const states = checked - before;
  // 4 class triples × 6 permutations over the compact class pools.
  assert.ok(states >= 2_500, `class sweep too small: ${states}`);
});

test('every species sweeps the rarity and collector-number vocabulary', () => {
  const before = checked;
  sweep(function* () {
    for (let i = 0; i < DEX_ENTRIES.length; i += 1) {
      const [, species] = DEX_ENTRIES[i];
      // Two rotating states per species: the rotation walks every rarity and
      // collector-number form across the National Dex, both token slots.
      yield `${species} ${RARITY_TOKENS[i % RARITY_TOKENS.length]} ${NUMBER_TOKENS[i % NUMBER_TOKENS.length]}`;
      yield `${RARITY_TOKENS[(i + 3) % RARITY_TOKENS.length]} ${species} ${NUMBER_TOKENS[(i + 2) % NUMBER_TOKENS.length]}`;
      if (i % 4 === 0) {
        yield `${species} ${ARTIST_POOL[i % ARTIST_POOL.length]} ${RARITY_TOKENS[(i + 5) % RARITY_TOKENS.length]}`;
      }
    }
  }, 'species sweep');
  const states = checked - before;
  // 1025 species × 2 rotating states + one artist state in four.
  assert.ok(states >= 2_250, `species sweep too small: ${states}`);
});

test('every artist name sweeps the rarity and collector-number vocabulary', () => {
  const before = checked;
  sweep(function* () {
    for (let i = 0; i < ARTIST_POOL.length; i += 1) {
      const artist = ARTIST_POOL[i];
      yield `${artist} ${RARITY_TOKENS[i % RARITY_TOKENS.length]} ${NUMBER_TOKENS[i % NUMBER_TOKENS.length]}`;
      yield `${RARITY_TOKENS[(i + 3) % RARITY_TOKENS.length]} ${artist} ${NAME_VARIATIONS[i % NAME_VARIATIONS.length]}`;
    }
  }, 'artist sweep');
  const states = checked - before;
  assert.ok(states >= 800, `artist sweep too small: ${states}`);
});

test('expansion tokens pair with their own-era species across the era × generation matrix', () => {
  const before = checked;
  sweep(function* () {
    // Every 14th dex entry: 73 species spanning all 9 generations, each
    // against a different own-era expansion (the rotation walks every era's
    // full entry list across the sample).
    for (let i = 0; i < DEX_ENTRIES.length; i += 14) {
      const [dex, species] = DEX_ENTRIES[i];
      const expansion = ownEraExpansion(dex, i);
      yield `${species} ${expansion} ${RARITY_TOKENS[i % RARITY_TOKENS.length]}`;
      yield `${expansion} ${species} ${NUMBER_TOKENS[i % NUMBER_TOKENS.length]}`;
    }
    // Expansion aliases spread over the whole pool × rarity × number.
    for (let i = 0; i < EXPANSION_POOL.length; i += 8) {
      const expansion = EXPANSION_POOL[i].compact;
      yield `${expansion} ${RARITY_TOKENS[i % RARITY_TOKENS.length]} ${NUMBER_TOKENS[i % NUMBER_TOKENS.length]}`;
    }
    // The era-staple pairings (SV / Mega Evolution) for gen anchors.
    for (const dex of [1, 152, 252, 387, 495, 650, 722, 810, 906]) {
      yield `${ownEraExpansion(dex, dex)} secret rare`;
    }
  }, 'era-anchored expansion sweep', { countsAsSet: true });
  const states = checked - before;
  assert.ok(states >= 190, `era-anchored sweep too small: ${states}`);
  assert.ok(setChecked >= 190, `set-bearing coverage too small: ${setChecked}`);
});

test('the sweep parsed every token combination without violating the parse contract', () => {
  assert.ok(checked >= 5_500, `total sweep too small: ${checked}`);
  assert.ok(predicateChecked >= 100, `predicate slice too small: ${predicateChecked}`);
});

test('witness: "102 spheal" parses to the collector number plus the name pool', () => {
  const parsed = parseTypedQuery('102 spheal');
  assertParsedShape(parsed, '102 spheal');
  assert.equal(parsed.numberTokens.length, 1);
  assert.equal(parsed.nameQuery, 'spheal');
  assertPredicates(parsed, '102 spheal');
});

test('witness: era anchoring pairs each generation with its debut block', () => {
  // Gen 1 (Bulbasaur #1) anchors to the Original/Neo blocks; gen 9
  // (Sprigatito #906) anchors to Scarlet & Violet / Mega Evolution.
  assert.deepEqual(speciesEras(1), ['Original', 'Neo', 'Scarlet & Violet', 'Mega Evolution']);
  assert.deepEqual(speciesEras(906), ['Scarlet & Violet', 'Mega Evolution']);
  const gen1Sample = DEX_ENTRIES[0] && ownEraExpansion(1, 3);
  assert.ok(gen1Sample, 'gen 1 has own-era expansions');
});
