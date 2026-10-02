'use strict';

const { printBucket } = require('./_print_bucket');

const TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, byKey: new Map() };

function cacheKey(name) {
  return String(name || '').trim().toLowerCase();
}

function lookupExpansionNationality(map, setName) {
  const raw = String(setName || '').trim();
  if (!raw || !map) {
    return '';
  }
  return map.get(cacheKey(raw)) || '';
}

async function loadExpansionNationalityMap(queryFn) {
  if (typeof queryFn !== 'function') {
    return cache.byKey;
  }
  if (Date.now() - cache.at < TTL_MS && cache.byKey.size) {
    return cache.byKey;
  }
  const result = await queryFn(`
    select name, normalized_name, nationality
    from public.pokoin_pokemon_expansions
  `);
  const byKey = new Map();
  for (const row of result?.rows || []) {
    const nationality = String(row.nationality || '').trim().toLowerCase();
    if (!nationality) {
      continue;
    }
    if (row.name) {
      byKey.set(cacheKey(row.name), nationality);
    }
    if (row.normalized_name) {
      byKey.set(cacheKey(row.normalized_name), nationality);
    }
  }
  cache = { at: Date.now(), byKey };
  return byKey;
}

async function attachExpansionNationality(groups, queryFn) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length || typeof queryFn !== 'function') {
    return list;
  }
  let map;
  try {
    map = await loadExpansionNationalityMap(queryFn);
  } catch {
    return list;
  }
  return list.map((group) => ({
    ...group,
    printings: (group.printings || []).map((printing) => {
      const fromExpansion = lookupExpansionNationality(
        map,
        printing.set || printing.set_name,
      );
      const existing = String(printing.nationality || '').trim().toLowerCase();
      // Prefer known printing nationality; fill from expansion when empty.
      // Never erase a known value with an empty expansion miss.
      const nationality = printBucket(existing) === 'unknown' ? (fromExpansion || existing) : existing;
      return nationality ? { ...printing, nationality } : printing;
    }),
  }));
}

function resetExpansionNationalityCache() {
  cache = { at: 0, byKey: new Map() };
}

module.exports = {
  attachExpansionNationality,
  lookupExpansionNationality,
  resetExpansionNationalityCache,
};
