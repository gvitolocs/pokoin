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
  isModifierWord,
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
import { resolverOwns, resolveSuggestQuery } from './suggest-resolve.js';
import { filterSuggestByPrintLang } from './locale.js';
import { mergePrintingFields } from './print-bucket.js';
import { rankFreeText, scoreGroups } from './search-score.js';

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

export function rememberSuggestGroups(groups, { searchLang = '' } = {}) {
  const at = Date.now();
  const stampLang = String(searchLang || '').toLowerCase();
  for (const group of groups || []) {
    const key = compactQuery(group?.name);
    if (!key) {
      continue;
    }
    const incoming = (group.printings || [])
      .filter((row) => (!isLiveStub(row) && String(row?.id || row?.card_id || '')))
      // Stamp the fetch language so the unified scorer only trusts localized_*
      // fields under the language they were actually fetched for (language is
      // part of cache identity; a stale cross-language response is ignored).
      .map((row) => (stampLang ? { ...row, search_lang: stampLang } : row));
    if (!incoming.length) {
      continue;
    }
    const byId = new Map(
      (byCompact.get(key)?.printings || []).map((row) => [String(row.id || row.card_id), row]),
    );
    for (const row of incoming) {
      const id = String(row.id || row.card_id);
      const prev = byId.get(id);
      // Empty hydration must not erase a known nationality / identity fields.
      byId.set(id, prev ? mergePrintingFields(prev, row) : row);
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

/**
 * Every live-cached group (real printings only), for the unified scorer to
 * surface localized / hydrated matches the English name ranker cannot see
 * (`Glurak` → Charizard while German is selected). Bounded by the cache cap.
 */
function allCachedGroups(now = Date.now()) {
  const groups = [];
  for (const [key, row] of byCompact) {
    if (now - row.at > TTL_MS) {
      continue;
    }
    const printings = (row.printings || []).filter((printing) => !isLiveStub(printing));
    if (printings.length) {
      groups.push({ name: printings[0].name || key, printings });
    }
  }
  return groups;
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
 * The gate lives in the resolver (resolverOwns): artist bindings plus the
 * narrow semantic-competition case (legacy peeled a set, but the winner is a
 * single compound-name literal projection — `palkia legend` → Palkia &
 * Dialga LEGEND). Everything else stays legacy.
 */

function toSetToken(entity) {
  return {
    token: entity.display,
    compact: entity.compact,
    eraId: entity.eraId || '',
    setNames: entity.setNames || [entity.display],
    needles: entity.needles || [entity.compact],
    slug: entity.slug || '',
    prefix: entity.exactness === 'prefix',
  };
}

function tierRows(tier, resolved, used) {
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
  const pools = [...nameRows, ...artistRows, ...setRows].filter((poolRows) => poolRows.length);
  if (!pools.length) {
    if (artistPending) {
      return [{ name: artistPending.display, printings: [stubPrinting(artistPending.display)] }];
    }
    return [];
  }
  let rows = intersectPools(pools);
  if (!rows.length) {
    rows = pools.reduce((best, poolRows) => (poolRows.length < best.length ? poolRows : best), pools[0]);
  }
  // Tier-own set constraint: strict only when another pool contributed rows,
  // so the set tier narrows the name reading instead of replacing it.
  const setTokens = tier.entities.set.map(toSetToken);
  if (setTokens.length && (nameRows.length || artistRows.length)) {
    const filtered = rows.filter((row) => printingMatchesSetFilter(row, {
      setTokens,
      eras: resolved.parsed.eras || [],
    }));
    if (filtered.length) {
      rows = filtered;
    }
  }
  return rows;
}

/**
 * Sectioned paint: each tier appends its rows (winning interpretation first,
 * then alternate readings, then the strongest single entity), then the ranked
 * name pool fills whatever is left. Tiers whose lexical cost runs away from
 * the winner stop the walk — junk readings never paint.
 */
function resolverLiveGroups(resolved, { limit }) {
  const ranked = rankNames(resolved.correctedQuery || resolved.query);
  const used = new Set();
  const rows = [];
  const costCap = resolved.best.cost + 1.5;
  for (const tier of resolved.tiers) {
    if (rows.length >= limit) {
      break;
    }
    if (tier !== resolved.best && tier.cost > costCap) {
      break;
    }
    for (const row of tierRows(tier, resolved, used)) {
      const id = String(row.id || row.card_id || '');
      if (id && !used.has(id)) {
        used.add(id);
        rows.push(row);
      }
    }
  }
  // Name-pool fill: after entity sections, the ranked pool rounds the popup
  // up to 20 so a sparse intersection never empties the board.
  if (rows.length && rows.length < limit) {
    for (const rankedRow of ranked) {
      if (rows.length >= limit) {
        break;
      }
      for (const printing of cachedPrintings(rankedRow.display)) {
        const id = String(printing.id || printing.card_id || '');
        if (id && !used.has(id)) {
          used.add(id);
          rows.push(printing);
          break;
        }
      }
    }
  }
  if (!rows.length) {
    return null;
  }
  return { groups: groupsFromCards(rows), ranked, each: limit };
}

/** Print language is a hard universe constraint. Zero matches stays empty —
 * never silently broaden to All / other print regions. */
function popupGroups(groups, printLang) {
  return filterSuggestByPrintLang(groups, printLang);
}

export function liveSuggestGroups(query, {
  rank = rankNames,
  pool,
  limit = SUGGEST_RESULT_FLOOR,
  preferPerGroup = 4,
  printLang = 'all',
  searchLang = 'en',
  kind = '',
} = {}) {
  if (!suggestLiveReady(query)) {
    return { groups: [], ranked: [], parsed: parseTypedQuery(query) };
  }
  const parsed = parseTypedQuery(query);
  const nameQuery = isBareCollectorQuery(parsed) ? query : (parsed.nameQuery || query);
  const intent = isBareCollectorQuery(parsed) ? { kind: 'name' } : catalogIntent(query);
  const resolved = isBareCollectorQuery(parsed) ? null : resolveSuggestQuery(query);
  // Artist bindings keep their hydrate branch; the resolver no longer OWNS a
  // free-text card query (`palkia legend`) — that goes through the one scorer.
  if (resolved && resolved.hasArtist && resolverOwns(resolved)) {
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
  // ---------------------------------------------------------------------------
  // ORDINARY FREE-TEXT SINGLES: one scorer owns it (search-score.js). No engine
  // fork, no destructive set-peel, no resolver pipeline swap. Set/mechanic
  // recognition is EVIDENCE only. Genuinely structured/browse queries keep
  // their own paths below: bare collector numbers, set-only browse
  // (`expedition`), art/rarity/number peels, the `energy` set browse, and
  // resolver artist bindings — each a hard universe constraint the coverage
  // scorer cannot express, not free-text card search.
  // A CONFIDENT set token is a real set alias/title the user browses by
  // (`sl` → Call of Legends, `platinum`, `call of legends`) — an opaque alias
  // the coverage scorer cannot reconstruct from set-name tokens, so it keeps
  // the set-aware browse path. A PREFIX peel (`pika` → Pikachu World
  // Collection) or a MODIFIER homonym (`legend`) is a false positive: those go
  // through the one scorer as evidence. This is the Section-7 boundary — only
  // fuzzy/prefix set recognition is demoted, never explicit set intent.
  const confidentSet = (parsed.setTokens || []).some((token) => (
    !token.prefix && !isModifierWord(token.token || token.compact)
  ));
  const isFreeText = !isBareCollectorQuery(parsed)
    && !isSetOnlyQuery(parsed)
    && !isNumberAwareQuery(parsed)
    && !isArtAwareQuery(parsed)
    && !isRarityAwareQuery(parsed)
    && !confidentSet
    && !(resolved && resolved.hasArtist);
  if (isFreeText) {
    const lang = String(searchLang || 'en').toLowerCase();
    // Name-pool order (English local vocab) for the returned `ranked` and FLIP.
    const ranked = pool
      ? rank(nameQuery, pool)
      : rankFreeText(query, { lang, limit: SUGGEST_RESULT_FLOOR * 2 });
    // The displayed rows are the live cache scored by the ONE model, filtered
    // to tokens actually covered and ordered by coverage→quality. Scoring the
    // whole cache (not just rankFreeText's top-N) keeps a low-quality-but-valid
    // reading (base `Pikachu` under `pikahc gx`) and surfaces server-hydrated
    // localized rows through the same code path — deterministic, order-free.
    const scored = scoreGroups(query, popupGroups(allCachedGroups(), printLang), { lang });
    // Free text is never a hard set filter: drop any peeled set token so fill /
    // order treat recognition as evidence. Mechanic words still ride the raw
    // query for fill's rival-mechanic consistency (`pika gx` hides ex prints).
    const freeParsed = { ...parsed, setTokens: [], eras: [], nameQuery: query };
    const each = typedModifiers(query).mods.length ? limit : preferPerGroup;
    return {
      groups: fillSuggestGroups(scored.groups, limit, each, freeParsed, kind),
      ranked,
      parsed: freeParsed,
    };
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
