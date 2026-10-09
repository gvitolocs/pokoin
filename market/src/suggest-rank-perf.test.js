import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAR_COST,
  INDEL_COST,
  KEYBOARD_COST,
  NAME_POOL,
  TRANSPOSE_COST,
  absorbNames,
  compactQuery,
  mulberry32,
  prefixEditDistance,
  rankNames,
  rankNamesExhaustive,
  twoInsertKeyboardTypo,
} from './suggest-rank.js';

// Verbatim copy of the pre-optimisation DP (2026-10-09) — the oracle.
const REF_KEY_NEIGHBORS = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj', i: 'uojk', o: 'ipkl', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huiknm', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  1: '2q', 2: '13qw', 3: '24we', 4: '35er', 5: '46rt', 6: '57ty', 7: '68yu', 8: '79ui', 9: '80io', 0: '9op',
};

function refSubstitutionCost(left, right) {
  if (left === right) {
    return 0;
  }
  const a = String(left || '');
  const b = String(right || '');
  if ((REF_KEY_NEIGHBORS[a] || '').includes(b) || (REF_KEY_NEIGHBORS[b] || '').includes(a)) {
    return KEYBOARD_COST;
  }
  return FAR_COST;
}

function refPrefixEditDistance(query, name) {
  const q = String(query || '');
  const n = String(name || '');
  const rows = q.length;
  const cols = n.length;
  if (!rows) {
    return 0;
  }
  if (!cols) {
    return rows * INDEL_COST;
  }
  let prev2 = new Float64Array(cols + 1);
  let prev = new Float64Array(cols + 1);
  let curr = new Float64Array(cols + 1);
  for (let j = 0; j <= cols; j += 1) {
    prev[j] = j * INDEL_COST;
  }
  for (let i = 1; i <= rows; i += 1) {
    curr[0] = i * INDEL_COST;
    const qc = q[i - 1];
    for (let j = 1; j <= cols; j += 1) {
      curr[j] = Math.min(
        prev[j] + INDEL_COST,
        curr[j - 1] + INDEL_COST,
        prev[j - 1] + refSubstitutionCost(qc, n[j - 1]),
      );
      if (i > 1 && j > 1 && qc === n[j - 2] && q[i - 2] === n[j - 1]) {
        const transposed = prev2[j - 2] + TRANSPOSE_COST;
        if (transposed < curr[j]) {
          curr[j] = transposed;
        }
      }
    }
    const recycled = prev2;
    prev2 = prev;
    prev = curr;
    curr = recycled;
  }
  let best = prev[0];
  for (let j = 1; j <= cols; j += 1) {
    if (prev[j] < best) {
      best = prev[j];
    }
  }
  return best;
}

const CUTOFFS = [0.5, 1, 2.5];
const FIXED = [
  'pikachu', 'pikahcu', 'p', 'pi', 'pik', 'o', 'oi', 'dawe', 'talflamd', 'elafon', 'miikyu ex',
  'pikahc gx', 'eevee i', 'palkia legen', 'charizrd', 'xyzqwv', 'zzzzzzzzzz', 'qqq', 'ピカチュウ',
  '061 shieldon', 'hgss energy', 'sh1', 'é', 'Pokémon', 'keldeo ex', '!!', 'q1w2',
];

function seededNames(count, seed) {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, () => NAME_POOL[Math.floor(rng() * NAME_POOL.length)]);
}

test('prefixEditDistance equals the original DP, and honours the cutoff contract', () => {
  const rng = mulberry32(7);
  const pairs = [
    ['ピカチュウ', 'ピカチュ'], ['pokemon', 'pokémon'], ['e', 'é'], ['cafegx', 'cafe'], ['', 'abc'], ['abc', ''],
  ];
  for (const row of seededNames(4000, 3)) {
    const other = NAME_POOL[Math.floor(rng() * NAME_POOL.length)].compact;
    const typo = twoInsertKeyboardTypo(row.compact, rng);
    pairs.push([row.compact.slice(0, 1 + Math.floor(rng() * 9)), other]);
    if (typo) pairs.push([typo, row.compact]);
  }
  for (const [query, name] of pairs) {
    const ref = refPrefixEditDistance(query, name);
    assert.equal(prefixEditDistance(query, name), ref, `${query} / ${name}`);
    for (const cutoff of CUTOFFS) {
      const bounded = prefixEditDistance(query, name, cutoff);
      if (ref <= cutoff + 1e-9) {
        assert.equal(bounded, ref, `${query} / ${name} @${cutoff}`);
      } else {
        assert.ok(bounded > cutoff + 1e-9, `${query} / ${name} @${cutoff}: ${bounded}`);
      }
    }
  }
});

test('rankNames (cap shortcut + memo) equals the exhaustive scan', () => {
  const pools = [NAME_POOL, absorbNames(NAME_POOL, [{ name: 'Pikachu ex' }, { name: 'Zzyzx Test' }])];
  for (const query of FIXED) {
    for (const pool of pools) {
      for (const opts of [undefined, { fill: 20 }]) {
        assert.deepStrictEqual(rankNames(query, pool, opts), rankNamesExhaustive(query, pool, opts), query);
      }
    }
  }
  // Prefixes and two-skip keyboard typos of seeded names, full pool.
  const queries = new Set();
  for (const row of seededNames(30, 13)) {
    for (let len = 1; len <= Math.min(6, row.display.length); len += 1) queries.add(row.display.slice(0, len));
  }
  const rng = mulberry32(11);
  for (const row of seededNames(40, 17)) {
    const typo = twoInsertKeyboardTypo(row.compact, rng);
    if (typo) queries.add(typo);
  }
  for (const query of queries) {
    assert.deepStrictEqual(rankNames(query), rankNamesExhaustive(query), query);
  }
});

test('compactQuery memo returns the same compaction for repeated and NFC/NFD input', () => {
  assert.equal(compactQuery('Pokémon'), 'pokemon');
  assert.equal(compactQuery('Pokémon'), compactQuery('Pokémon'));
  assert.notEqual(compactQuery('ピ'), compactQuery('ヒ'));
  assert.equal(compactQuery('Pikachu δ Delta Species'), compactQuery('Pikachu δ Delta Species'));
});

test('timing: 7 pikachu keystrokes on a fresh pool (informational)', () => {
  const prefixes = ['p', 'pi', 'pik', 'pika', 'pikac', 'pikach', 'pikachu'];
  let fast = 0;
  let full = 0;
  for (const prefix of prefixes) {
    let pool = absorbNames(NAME_POOL, []);
    let start = performance.now();
    rankNames(prefix, pool);
    fast += performance.now() - start;
    pool = absorbNames(NAME_POOL, []);
    start = performance.now();
    rankNamesExhaustive(prefix, pool);
    full += performance.now() - start;
  }
  console.log(`rankNames ${fast.toFixed(1)} ms vs exhaustive ${full.toFixed(1)} ms for 7 keystrokes`);
});
