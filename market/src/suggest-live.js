/**
 * PIPELINE BLOCK: live typeahead (SPA)
 * ------------------------------------
 * CardTrader loads a local catalog so the popup is always open and printings
 * unique blueprint names in NAME_POOL. Rank once per keystroke on the main
 * thread (memoized); workers hydrate Meili in the background. The list opens
 * on the third compact character from that cache so rows are instant; further
 * letters reorder them (FLIP) while Meili keeps filling. Name rows are real
 * cached printings only — never live: stubs to pad toward 20. `hgss energy`
 * scans the cache for HeartGold-era energies (elementals first). `palkai sl`
 * and `palkia legen` peel Call of Legends, then fill 20 from that name pool.
 * Bare `expedition` hydrates the expansion and fills 20 singles from that set.
 * Typed `keldeo ex` fills EX printings and skips rival GX/V from the live cache.
 * Jumbos sit on the Product tab.
 *
 * Revert: Chrome.jsx fetchSuggestRanked-only, 120ms debounce, no cache.
 */

import {
  compactQuery,
  fillSuggestGroups,
  isArtAwareQuery,
  isBareCollectorQuery,
  isNumberAwareQuery,
  isRarityAwareQuery,
  isSetAwareQuery,
  isSetOnlyQuery,
  hasRivalMechanic,
  typedModifiers,
  mergeSuggestGroups,
  orderEnergyGroups,
  orderSuggestGroups,
  parseTypedQuery,
  printingMatchesNumberFilter,
  printingMatchesSetFilter,
  printingNumberRank,
  rankNames,
  SUGGEST_RESULT_FLOOR,
} from './suggest-rank.js';
import { catalogCacheKey, catalogIntent, groupsFromCards } from './suggest-catalog.js';
import { resolveSuggestQuery } from './suggest-resolve.js';
import { filterSuggestByPrintLang } from './locale.js';

export const SUGGEST_LIVE_MIN_CHARS = 3;
const TTL_MS = 30 * 60 * 1000;
const MAX_NAMES = 2500;
const byCompact = new Map();

export function suggestLiveReady(query) {
  return compactQuery(query).length >= SUGGEST_LIVE_MIN_CHARS;
}

export function resetSuggestLive() {
  byCompact.clear();
}

export function isLiveStub(printing = {}) {
  return printing.live === true || String(printing.id || printing.card_id || '').startsWith('live:');
}

export function stubPrinting(display) {
  const compact = compactQuery(display);
  return {
    id: `live:${compact}`,
    name: display,
    live: true,
    product_type: 'card',
    item_kind: 'single',
  };
}

function pruneLiveCache(now = Date.now()) {
  for (const [key, row] of byCompact) {
    if (now - row.at > TTL_MS) {
      byCompact.delete(key);
    }
  }
  while (byCompact.size > MAX_NAMES) {
    const oldest = byCompact.keys().next().value;
    byCompact.delete(oldest);
  }
}

export function rememberSuggestGroups(groups) {
  const at = Date.now();
  for (const group of groups || []) {
    const key = compactQuery(group?.name);
    if (!key) {
      continue;
    }
    const incoming = (group.printings || []).filter((row) => (
      !isLiveStub(row) && String(row?.id || row?.card_id || '')
    ));
    if (!incoming.length) {
      continue;
    }
    const byId = new Map(
      (byCompact.get(key)?.printings || []).map((row) => [String(row.id || row.card_id), row]),
    );
    for (const row of incoming) {
      byId.set(String(row.id || row.card_id), row);
    }
    byCompact.set(key, { printings: [...byId.values()], at });
  }
  pruneLiveCache(at);
}

export function rememberPrintings(key, printings) {
  rememberSuggestGroups([{ name: key, printings }]);
}

export function cachedPrintings(name) {
  const row = byCompact.get(compactQuery(name));
  if (!row || Date.now() - row.at > TTL_MS) {
    return [];
  }
  return row.printings;
}

function cachedNumberPrintings(parsed) {
  const out = [];
  const seen = new Set();
  for (const row of byCompact.values()) {
    for (const printing of row.printings || []) {
      if (isLiveStub(printing) || !printingMatchesNumberFilter(printing, parsed)) {
        continue;
      }
      const id = String(printing.id || printing.card_id || '');
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(printing);
    }
  }
  out.sort((left, right) => (
    printingNumberRank(left, parsed) - printingNumberRank(right, parsed)
    || String(left.name || '').localeCompare(String(right.name || ''))
    || String(left.number || left.card_number || '').localeCompare(
      String(right.number || right.card_number || ''),
    )
  ));
  return out;
}

function cachedSetPrintings(parsed, nameTest) {
  const out = [];
  const seen = new Set();
  for (const row of byCompact.values()) {
    for (const printing of row.printings || []) {
      if (isLiveStub(printing) || !printingMatchesSetFilter(printing, parsed)) {
        continue;
      }
      if (nameTest && !nameTest(printing)) {
        continue;
      }
      const id = String(printing.id || printing.card_id || '');
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(printing);
    }
  }
  return out;
}

function dedupeBySlug(entities) {
  const bySlug = new Map();
  for (const entity of entities) {
    const key = entity.slug || entity.compact;
    if (!bySlug.has(key)) {
      bySlug.set(key, entity);
    }
  }
  return [...bySlug.values()];
}

function intersectPools(pools) {
  if (!pools.length) {
    return [];
  }
  const [first, ...rest] = pools;
  const ids = new Set();
  for (const row of first) {
    const id = String(row.id || row.card_id || '');
    if (id && rest.every((pool) => pool.some((other) => String(other.id || other.card_id || '') === id))) {
      ids.add(id);
    }
  }
  const out = [];
  const seen = new Set();
  for (const pool of pools) {
    for (const row of pool) {
      const id = String(row.id || row.card_id || '');
      if (ids.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(row);
      }
    }
  }
  return out;
}

/**
 * The resolver takes over only for artist bindings — the class the legacy
 * whole-compact parse misroutes (`kawayod`, `pika yuka`). Pure name + typo
 * and modifier queries stay on the legacy ranked pool: its mechanic bonus
 * and rival filtering are locked fixture behavior.
 */
function resolverApplies(resolved) {
  return Boolean(resolved?.best?.entities.artist.length);
}

/** The print flag shapes the popup, it must never blind it: when the filter
 * would empty every group, paint the unfiltered rows instead — the user
 * still gets the closest matches (imageless prints included) over an empty
 * "No singles match" board. */
function popupGroups(groups, printLang) {
  const filtered = filterSuggestByPrintLang(groups, printLang);
  return filtered.length ? filtered : (groups || []);
}

/**
 * Intersection-first paint from the hypothesis entities against the suggest
 * cache: all resolved constraints when the cache can satisfy them, then the
 * relaxation tiers (drop weakest constraint → strongest entity). Entities
 * not yet hydrated paint as a stub row until their hydration lands.
 */
function resolverLiveGroups(resolved, { limit, preferPerGroup }) {
  const ranked = rankNames(resolved.correctedQuery);
  for (const tier of resolved.tiers) {
    const nameRows = [];
    for (const entity of tier.entities.name) {
      nameRows.push(cachedPrintings(entity.display));
    }
    const artistRows = [];
    let artistPending = null;
    for (const entity of dedupeBySlug(tier.entities.artist)) {
      const rows = cachedPrintings(`artist:${entity.slug}`);
      if (rows.length) {
        artistRows.push(rows);
      } else if (!artistPending) {
        artistPending = entity;
      }
    }
    const setRows = [];
    for (const entity of dedupeBySlug(tier.entities.set)) {
      if (entity.slug) {
        setRows.push(cachedPrintings(`set:${entity.slug}`));
      }
    }
    const pools = [...nameRows, ...artistRows, ...setRows].filter((pool) => pool.length);
    if (!pools.length) {
      if (artistPending || tier.entities.set.some((entity) => entity.slug)) {
        const pending = artistPending
          ? [{ name: artistPending.display, printings: [stubPrinting(artistPending.display)] }]
          : [];
        return {
          groups: pending,
          ranked,
          each: limit,
        };
      }
      continue;
    }
    let rows = intersectPools(pools);
    if (!rows.length) {
      rows = pools.reduce((best, pool) => (pool.length < best.length ? pool : best), pools[0]);
    }
    const setTokens = resolved.parsed.setTokens || [];
    if (setTokens.length) {
      const filtered = rows.filter((row) => printingMatchesSetFilter(row, {
        setTokens,
        eras: resolved.parsed.eras || [],
      }));
      if (filtered.length) {
        rows = filtered;
      }
    }
    return {
      groups: groupsFromCards(rows),
      ranked,
      each: setTokens.length || tier.entities.artist.length ? limit : preferPerGroup,
    };
  }
  return null;
}

export function liveSuggestGroups(query, {
  rank = rankNames,
  pool,
  limit = SUGGEST_RESULT_FLOOR,
  preferPerGroup = 4,
  printLang = 'all',
  kind = '',
} = {}) {
  if (!suggestLiveReady(query)) {
    return { groups: [], ranked: [], parsed: parseTypedQuery(query) };
  }
  const parsed = parseTypedQuery(query);
  const nameQuery = isBareCollectorQuery(parsed) ? query : (parsed.nameQuery || query);
  const intent = isBareCollectorQuery(parsed) ? { kind: 'name' } : catalogIntent(query);
  const resolved = isBareCollectorQuery(parsed) ? null : resolveSuggestQuery(query);
  if (resolved && resolverApplies(resolved)) {
    const branch = resolverLiveGroups(resolved, { limit, preferPerGroup });
    if (branch) {
      return {
        groups: fillSuggestGroups(
          popupGroups(branch.groups, printLang),
          limit,
          branch.each,
          resolved.parsed,
          kind,
        ),
        ranked: branch.ranked,
        parsed: resolved.parsed,
        resolved,
        intent,
      };
    }
  }
  // Token-peeled queries rank the local name pool. The parse already split the
  // tokens off, and catalogIntent's fuzzy catalog rank misranks mid-typing
  // (`eevee illu` ≈ Eeveelutions products — plain Eevee drops out and the
  // popup goes empty or jumps between keystrokes). Set-only queries stay on
  // the intent branch: bare `expedition` browses that set's cached printings.
  const tokenPeeled = !isBareCollectorQuery(parsed) && (
    isArtAwareQuery(parsed)
    || isRarityAwareQuery(parsed)
    || isNumberAwareQuery(parsed)
    || isSetAwareQuery(parsed)
  );
  if (!tokenPeeled && (intent.kind === 'artist' || intent.kind === 'set')) {
    const printings = cachedPrintings(catalogCacheKey(intent));
    const groups = printings.length
      ? groupsFromCards(printings)
      : [{ name: intent.display, printings: [stubPrinting(intent.display)] }];
    const each = intent.kind === 'set' || isSetOnlyQuery(parsed) ? limit : preferPerGroup;
    return {
      groups: fillSuggestGroups(
        popupGroups(groups, printLang),
        limit,
        each,
        parsed,
        kind,
      ),
      ranked: intent.ranked || [],
      parsed,
      intent,
    };
  }
  const ranked = pool
    ? rank(nameQuery, pool)
    : (!tokenPeeled && intent.kind === 'name' && intent.ranked?.length
      ? intent.ranked
      : rank(nameQuery));
  const mods = typedModifiers(query).mods;
  const nameGroups = ranked.flatMap((row) => {
    if (mods.length && hasRivalMechanic(row.display, mods)) {
      return [];
    }
    const printings = cachedPrintings(row.display);
    if (!printings.length) {
      return [];
    }
    return [{ name: row.display, printings }];
  });
  const collectorGroups = isBareCollectorQuery(parsed)
    ? groupsFromCards(cachedNumberPrintings(parsed))
    : [];
  const energySetGroups = isSetAwareQuery(parsed) && compactQuery(nameQuery) === 'energy'
    ? groupsFromCards(cachedSetPrintings(parsed, (row) => /energy/i.test(row.name || '')))
    : [];
  const merged = mergeSuggestGroups([collectorGroups, energySetGroups, nameGroups]);
  let ordered = orderSuggestGroups(
    popupGroups(merged, printLang),
    ranked,
    parsed,
  );
  if (compactQuery(nameQuery) === 'energy') {
    ordered = orderEnergyGroups(ordered);
  }
  const peeled = isSetAwareQuery(parsed)
    || isSetOnlyQuery(parsed)
    || isArtAwareQuery(parsed)
    || isRarityAwareQuery(parsed)
    || (isNumberAwareQuery(parsed) && !isBareCollectorQuery(parsed));
  const each = compactQuery(nameQuery) === 'energy' && isSetAwareQuery(parsed)
    ? 2
    : (peeled || mods.length ? limit : preferPerGroup);
  return {
    groups: fillSuggestGroups(ordered, limit, each, parsed, kind),
    ranked,
    parsed,
  };
}
