/**
 * PIPELINE BLOCK: query-hypothesis resolver (SPA)
 * ----------------------------------------------
 * Google-style per-token autocorrect over the local 11k vocabulary. The query
 * becomes a small set of hypotheses; each hypothesis binds token spans to
 * vocabulary entities (name / artist / set) plus protected syntax (collectors,
 * art/rarity aliases, mechanics) carried over from parseTypedQuery.
 *
 * Steps: normalize → exact whole-entity lock → protected syntax → span
 * candidates (word trie + set-alias machinery + fuzzy) → beam of ≤8
 * hypotheses ranked by [coverage, correction cost, compatibility, exactness,
 * popularity]. Popularity only breaks ties; it never decides kind. The best
 * hypothesis paints instantly (FLIP tiles keep moving); relaxation tiers
 * (all constraints → drop weakest → strongest entity) keep the popup from
 * emptying, and the legacy whole-compact path stays as the final fallback in
 * suggest-live.js.
 *
 * Meili hydrates with the CORRECTED text as primary and the raw typed query as
 * challenger; the popup count comes from the corrected lookups only.
 *
 * Revert: suggest-live.js legacy body only, Chrome.jsx catalogIntent hydrate.
 */

import {
  ARTIST_POOL,
  SET_POOL,
} from './suggest-catalog.js';
import {
  NAME_POOL,
  compactQuery,
  exactSetAlias,
  expansionPrefixSet,
  isModifierWord,
  maxDistance,
  namePoolHasCompact,
  parseCollectorWord,
  parseTypedQuery,
  prefixEditDistance,
  rankNames,
  rankedSetAlias,
} from './suggest-rank.js';

const MAX_BEAM = 8;
/** Alternatives kept per span before hypothesis assembly. */
const SPAN_ALTERNATIVES = 3;
/** Free (unresolved) token cost — an entity span is almost always better. */
const FREE_TOKEN_COST = 1;
const RESOLVE_MEMO_MAX = 32;
const resolveMemo = new Map();
/** Span candidates recur across hypotheses and keystrokes (`pika` at pos 0). */
const SPAN_MEMO_MAX = 512;
const spanMemo = new Map();

function splitWords(display) {
  return String(display || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => compactQuery(word))
    .filter(Boolean);
}

/** Unified entity vocabulary: names + artists (+ their last-name rows) + set titles. */
const VOCAB = [
  ...NAME_POOL.map((row) => ({
    kind: 'name',
    display: row.display,
    compact: row.compact,
    words: splitWords(row.display),
    prior: row.prior,
    slug: '',
  })),
  ...ARTIST_POOL.map((row) => ({
    kind: 'artist',
    display: row.display,
    compact: row.compact,
    words: splitWords(row.display),
    prior: row.prior,
    slug: row.slug || '',
  })),
  ...SET_POOL.map((row) => ({
    kind: 'set',
    display: row.display,
    compact: row.compact,
    words: splitWords(row.display),
    prior: row.prior,
    slug: row.slug || '',
  })),
];
// Keep the precomputed compacts: artist last-name rows carry `sugimori`-style
// compacts that differ from compactQuery(display).
const VOCAB_ROWS = VOCAB.map((row) => ({ display: row.display, compact: row.compact, prior: row.prior }));
const VOCAB_BY_COMPACT = new Map();
for (const entry of VOCAB) {
  const existing = VOCAB_BY_COMPACT.get(entry.compact);
  if (!existing || entry.prior > existing.prior) {
    VOCAB_BY_COMPACT.set(entry.compact, entry);
  }
}
const MAX_SPAN_WORDS = Math.min(6, VOCAB.reduce((n, row) => Math.max(n, row.words.length), 1));

/** Word trie: walk token comps, multi-word entities sit on terminals. */
const TRIE = { kids: new Map(), entries: [] };
for (const entry of VOCAB) {
  if (entry.words.length < 2) {
    continue;
  }
  let node = TRIE;
  for (const word of entry.words) {
    let kid = node.kids.get(word);
    if (!kid) {
      kid = { kids: new Map(), entries: [] };
      node.kids.set(word, kid);
    }
    node = kid;
  }
  node.entries.push(entry);
}

function collectSubtree(node, out, cap) {
  if (!node || out.length >= cap) {
    return;
  }
  for (const entry of node.entries) {
    out.push(entry);
    if (out.length >= cap) {
      return;
    }
  }
  for (const kid of node.kids.values()) {
    collectSubtree(kid, out, cap);
    if (out.length >= cap) {
      return;
    }
  }
}

/**
 * Trie candidates for a token span: exact phrase walk, then the last word as a
 * prefix (`call of` → Call of Legends while still typing).
 */
function trieCandidates(comps, start, end) {
  let node = TRIE;
  for (let i = start; i < end; i += 1) {
    node = node.kids.get(comps[i]);
    if (!node) {
      return [];
    }
  }
  const last = comps[end];
  const kid = last ? node.kids.get(last) : null;
  const prefixHits = [];
  if (kid) {
    collectSubtree(kid, prefixHits, 4);
  }
  return [...(last ? [] : node.entries), ...prefixHits].slice(0, 4);
}

function fuzzyCandidates(comps, start, end) {
  if (start !== end || !comps[start]) {
    return [];
  }
  return rankNames(comps[start], VOCAB_ROWS, { fill: 6 })
    .filter((row) => row.distance <= maxDistance(comps[start].length) + 1e-9)
    .slice(0, 3);
}

function setAliasEntry(packed, distance, exactness) {
  const display = packed.setNames[0];
  return {
    kind: 'set',
    display,
    compact: compactQuery(display),
    words: splitWords(display),
    prior: 1,
    slug: '',
    eraId: packed.eraId || '',
    setNames: packed.setNames,
    needles: packed.needles,
    distance,
    exactness,
  };
}

function setAliasCandidates(spanRaw, spanCompactText, wordCount, isLast) {
  const out = [];
  // An exact blueprint name never binds as a set title (D00005N).
  if (wordCount === 1 && namePoolHasCompact(spanCompactText)) {
    return out;
  }
  if (wordCount === 1) {
    const exact = exactSetAlias(spanRaw);
    if (exact?.setNames?.length) {
      out.push(setAliasEntry(exact, 0, 'exact'));
    }
    const prefix = spanCompactText.length >= 4 ? expansionPrefixSet(spanCompactText) : null;
    if (prefix?.setNames?.length) {
      out.push(setAliasEntry(prefix, 0.25, 'prefix'));
    }
    return out;
  }
  // Multi-word set phrases only bind when they are the exact full title, or
  // when they end the query (`call of` still typing → Call of Legends).
  const fuzzy = rankedSetAlias(spanRaw);
  if (fuzzy?.withinCap && fuzzy.compact && fuzzy.distance <= 0.5) {
    const fullLength = spanCompactText.length === fuzzy.compact.length && fuzzy.distance === 0;
    if (fullLength || isLast) {
      const viaIndex = exactSetAlias(fuzzy.display) || exactSetAlias(fuzzy.compact);
      if (viaIndex?.setNames?.length) {
        out.push(setAliasEntry(viaIndex, fuzzy.distance, fullLength ? 'exact' : 'prefix'));
      }
    }
  }
  return out;
}

function labelExactness(candidate, spanCompactText) {
  if (candidate.distance === 0 && candidate.compact.length === spanCompactText.length) {
    return 'exact';
  }
  if (candidate.distance === 0) {
    return 'prefix';
  }
  return 'fuzzy';
}

export function candidateCost(candidate) {
  if (candidate.exactness === 'exact') {
    return 0;
  }
  if (candidate.exactness === 'prefix') {
    return 0.25 + candidate.distance;
  }
  // A capped fuzzy hit must still beat leaving the token unresolved.
  return 0.75 + candidate.distance * 0.1;
}

function dedupeCandidates(list) {
  const seen = new Set();
  return list.filter((row) => {
    const key = `${row.kind}:${row.compact}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function spanCandidates(comps, start, end, total) {
  const spanCompactText = comps.slice(start, end + 1).join('');
  const memoKey = `${total}:${spanCompactText}`;
  const cached = spanMemo.get(memoKey);
  if (cached) {
    return cached;
  }
  const spanRaw = comps.slice(start, end + 1).join(' ');
  const out = [];
  for (const entry of trieCandidates(comps, start, end)) {
    const distance = prefixEditDistance(spanCompactText, entry.compact);
    out.push({
      ...entry,
      distance,
      exactness: labelExactness({ distance, compact: entry.compact }, spanCompactText),
    });
  }
  for (const row of setAliasCandidates(spanRaw, spanCompactText, end - start + 1, end === total - 1)) {
    out.push(row);
  }
  // Fuzzy candidates still run unless something matched exactly: an alias
  // prefix (`pika` → Pikachu World Collection) must not suppress the exact
  // name candidate (`pika` → Pikachu).
  if (!out.some((row) => row.exactness === 'exact')) {
    for (const row of fuzzyCandidates(comps, start, end)) {
      out.push({
        kind: VOCAB_BY_COMPACT.get(row.compact)?.kind || 'name',
        display: row.display,
        compact: row.compact,
        words: splitWords(row.display),
        prior: row.prior,
        slug: VOCAB_BY_COMPACT.get(row.compact)?.slug || '',
        distance: row.distance,
        exactness: labelExactness(row, spanCompactText),
      });
    }
  }
  const ranked = dedupeCandidates(out)
    .sort((left, right) => (
      candidateCost(left) - candidateCost(right)
      || right.prior - left.prior
    ))
    .slice(0, SPAN_ALTERNATIVES);
  spanMemo.set(memoKey, ranked);
  if (spanMemo.size > SPAN_MEMO_MAX) {
    spanMemo.delete(spanMemo.keys().next().value);
  }
  return ranked;
}

/** Protected tokens never go through fuzzy entity resolution. */
function protectedTokens(raw) {
  const parsed = parseTypedQuery(raw);
  const words = raw.split(/\s+/).filter(Boolean);
  const protectedWords = new Set();
  const collect = (tokens, sink) => {
    for (const token of tokens || []) {
      for (const piece of String(token.token || token.raw || token.compact || '').split(/\s+/)) {
        if (piece) {
          protectedWords.add(piece);
          sink.push(piece);
        }
      }
    }
  };
  const numbers = [];
  collect(parsed.numberTokens, numbers);
  const art = [];
  collect(parsed.artTokens, art);
  const rarity = [];
  collect(parsed.rarityTokens, rarity);
  // Mechanic words ride the name text (corrected query keeps them) but never
  // bind entity spans — `v` must not become the LV.X deck set. The two
  // documented homonyms stay bindable: `legend`/`legen` peel as Call of
  // Legends (D00002M), and solo `Lugia LEGEND` names lock at STEP 1 (D000019).
  const SET_ALIAS_HOMONYMS = new Set(['legend', 'legen']);
  const spannable = [];
  const free = [];
  for (const word of words) {
    if (protectedWords.has(word)) {
      continue;
    }
    const number = parseCollectorWord(word);
    if (number) {
      protectedWords.add(word);
      numbers.push(word);
      continue;
    }
    free.push(word);
    spannable.push(!isModifierWord(word) || SET_ALIAS_HOMONYMS.has(compactQuery(word)));
  }
  return {
    parsed,
    free,
    spannable,
  };
}

function entityMap(spans) {
  const entities = { name: [], artist: [], set: [] };
  for (const span of spans) {
    if (span.candidate) {
      entities[span.candidate.kind].push(span.candidate);
    }
  }
  return entities;
}

function compatPenalty(entities) {
  let penalty = 0;
  if (entities.name.length > 1) {
    penalty += 1 * (entities.name.length - 1);
  }
  if (entities.artist.length > 1) {
    penalty += 0.5 * (entities.artist.length - 1);
  }
  if (entities.set.length > 1) {
    penalty += 0.5 * (entities.set.length - 1);
  }
  return penalty;
}

/**
 * Final tiebreak before popularity: at equal cost and exactness the kind the
 * legacy engine favored wins (`shi` → Shinx, not a same-prefix artist).
 * Popularity must never decide the kind on its own.
 */
const KIND_RANK = { name: 0, set: 1, artist: 2 };

function kindRankOf(spans) {
  let rank = 3;
  for (const span of spans) {
    const value = KIND_RANK[span.candidate.kind];
    if (value != null && value < rank) {
      rank = value;
    }
  }
  return rank;
}

function coveredTokens(state) {
  return state.spans.reduce((n, span) => n + (span.end - span.start + 1), 0);
}

/**
 * Resolve a typed query into ranked hypotheses. Every returned hypothesis has
 * consumed the whole query (entity spans + free tokens); ranking is
 * [coverage desc, cost asc, compatibility asc, exactness asc, popularity desc].
 */
export function resolveSuggestQuery(query) {
  const raw = String(query || '').trim();
  const compact = compactQuery(raw);
  if (!compact) {
    return null;
  }
  const cached = resolveMemo.get(compact);
  if (cached) {
    return cached;
  }
  const result = buildResolution(raw, compact);
  resolveMemo.set(compact, result);
  if (resolveMemo.size > RESOLVE_MEMO_MAX) {
    resolveMemo.delete(resolveMemo.keys().next().value);
  }
  return result;
}

function buildResolution(raw, compact) {
  const words = raw.split(/\s+/).filter(Boolean);
  const comps = words.map((word) => compactQuery(word)).filter(Boolean);
  const guard = protectedTokens(raw);

  // STEP 1: exact whole-entity lock. A locked entity is never re-tokenized,
  // so `Palkia & Dialga Legend` cannot decompose into three fuzzy spans.
  const locked = VOCAB_BY_COMPACT.get(compact);
  if (locked) {
    return finalize(raw, words, comps, guard, [{
      spans: [{ start: 0, end: Math.max(0, comps.length - 1), candidate: { ...locked, distance: 0, exactness: 'exact' } }],
      free: [],
      cost: 0,
      exactnessRank: 0,
      popularity: locked.prior,
    }], true);
  }

  // STEP 2/3: beam over the free (non-protected) tokens. Every state in the
  // beam at iteration `pos` has consumed exactly `pos` tokens.
  const freeComps = guard.free.map((word) => compactQuery(word)).filter(Boolean);
  const spanFlags = guard.spannable.filter((_, index) => Boolean(freeComps[index]));
  const total = freeComps.length;
  let beam = [{
    spans: [],
    free: [],
    cost: 0,
    exactnessRank: 3,
    popularity: 0,
  }];
  for (let pos = 0; pos < total; pos += 1) {
    const next = [];
    for (const state of beam) {
      const consumed = coveredTokens(state) + state.free.length;
      if (consumed > pos) {
        // A multi-token span already advanced past this position: carry it.
        next.push(state);
        continue;
      }
      if (consumed < pos) {
        continue;
      }
      if (spanFlags[pos] !== false) {
        for (let end = pos; end < Math.min(total, pos + MAX_SPAN_WORDS); end += 1) {
          for (const candidate of spanCandidates(freeComps, pos, end, total)) {
            next.push({
              spans: [...state.spans, { start: pos, end, candidate }],
              free: state.free,
              cost: state.cost + candidateCost(candidate),
              exactnessRank: Math.min(
                state.exactnessRank,
                candidate.exactness === 'exact' ? 0 : candidate.exactness === 'prefix' ? 1 : 2,
              ),
              popularity: state.popularity + candidate.prior,
            });
          }
        }
      }
      next.push({
        spans: state.spans,
        free: [...state.free, { comp: freeComps[pos] }],
        cost: state.cost + FREE_TOKEN_COST,
        exactnessRank: state.exactnessRank,
        popularity: state.popularity,
      });
    }
    next.sort((left, right) => (
      left.cost - right.cost
      || coveredTokens(right) - coveredTokens(left)
      || right.popularity - left.popularity
    ));
    beam = next.slice(0, MAX_BEAM);
  }

  return finalize(raw, words, comps, guard, beam, false);
}

function finalize(raw, words, comps, guard, states, locked) {
  const compact = compactQuery(raw);
  const protectedCount = words.length - guard.free.length;
  const hypotheses = states.map((state) => {
    const spans = state.spans.map((span) => ({
      ...span,
      raw: comps.slice(span.start, span.end + 1).join(' '),
    }));
    const entities = entityMap(spans);
    const compat = compatPenalty(entities);
    const coverage = locked ? 1 : Math.min(1,
      (coveredTokens(state) + state.free.length + protectedCount) / Math.max(1, comps.length));
    return {
      spans,
      free: state.free.map((row) => ({
        ...row,
        raw: words.find((word) => compactQuery(word) === row.comp) || row.comp,
      })),
      entities,
      // Compatibility folds into cost so a junk multi-entity parse cannot win
      // on raw span economics alone.
      cost: state.cost + compat,
      coverage,
      exactnessRank: state.exactnessRank,
      kindRank: locked ? 0 : kindRankOf(spans),
      popularity: state.popularity,
      compat,
      locked: Boolean(locked),
    };
  }).sort(compareHypotheses);
  const best = hypotheses[0] || null;
  const nameQuery = best
    ? [...best.entities.name.map((row) => row.display), ...best.free.map((row) => row.raw)]
      .join(' ')
      .trim()
    : raw;
  const parsed = {
    ...guard.parsed,
    // The resolver owns set decisions now: rebuild setTokens from the winning
    // spans so downstream set filters (printingMatchesSetFilter) keep working,
    // and drop any legacy peel that the hypothesis step did not confirm.
    setTokens: best
      ? best.entities.set.map((row) => ({
        token: row.display,
        compact: row.compact,
        eraId: row.eraId || '',
        setNames: row.setNames || [row.display],
        needles: row.needles || [row.compact],
        slug: row.slug || '',
        prefix: row.exactness === 'prefix',
      }))
      : [],
    nameQuery,
  };
  return {
    query: raw,
    compact,
    hypotheses,
    best,
    // Relaxation tiers: full constraints → drop the weakest → strongest entity.
    tiers: best ? buildTiers(best) : [],
    correctedQuery: nameQuery,
    freeText: best ? best.free.map((row) => row.raw) : words,
    parsed,
    hasArtist: Boolean(best?.entities.artist.length),
    hasSet: Boolean(best?.entities.set.length),
  };
}

function compareHypotheses(left, right) {
  return right.coverage - left.coverage
    || left.cost - right.cost
    || left.compat - right.compat
    || left.exactnessRank - right.exactnessRank
    || left.kindRank - right.kindRank
    || right.popularity - left.popularity;
}

function buildTiers(best) {
  const tiers = [best];
  const entityCount = best.entities.name.length + best.entities.artist.length + best.entities.set.length;
  if (entityCount > 1) {
    let weakest = 0;
    let weakestScore = -1;
    for (let i = 0; i < best.spans.length; i += 1) {
      const candidate = best.spans[i].candidate;
      const score = candidateCost(candidate) + (candidate.exactness === 'exact' ? 0 : 0.5);
      if (score > weakestScore) {
        weakestScore = score;
        weakest = i;
      }
    }
    const relaxedSpans = best.spans.filter((_, index) => index !== weakest);
    tiers.push({
      ...best,
      spans: relaxedSpans,
      entities: entityMap(relaxedSpans),
      free: [...best.free, { comp: best.spans[weakest].candidate.compact, raw: best.spans[weakest].raw }],
      cost: best.cost + FREE_TOKEN_COST,
    });
  }
  if (best.spans.length > 1) {
    const single = [...best.spans].sort((left, right) => (
      candidateCost(left.candidate) - candidateCost(right.candidate)
      || right.candidate.prior - left.candidate.prior
    ))[0];
    tiers.push({
      ...best,
      spans: [single],
      entities: entityMap([single]),
      free: best.free,
      cost: best.cost,
    });
  }
  return tiers;
}

export function resetResolveMemo() {
  resolveMemo.clear();
  spanMemo.clear();
}

/**
 * Serialize the winning hypothesis for the results page, so pressing Enter or
 * "View all" lands on the same meaning the popup painted. Format:
 * `name:Pikachu~artist:yuka-morii~set:call-of-legends`.
 */
export function serializeResolution(resolved) {
  const best = resolved?.best;
  if (!best) {
    return '';
  }
  const parts = [];
  for (const entity of best.entities.name) {
    if (entity.display) {
      parts.push(`name:${entity.display}`);
    }
  }
  for (const entity of dedupeBySlugExport(best.entities.artist)) {
    if (entity.slug) {
      parts.push(`artist:${entity.slug}`);
    }
  }
  for (const entity of dedupeBySlugExport(best.entities.set)) {
    if (entity.slug) {
      parts.push(`set:${entity.slug}`);
    }
  }
  if (!parts.length && best.free.length) {
    parts.push(`free:${best.free.map((row) => row.raw).join(' ')}`);
  }
  return parts.join('~');
}

export function parseResolutionParam(value) {
  const out = { names: [], artists: [], sets: [], free: [] };
  for (const part of String(value || '').split('~')) {
    const idx = part.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const kind = part.slice(0, idx);
    const raw = part.slice(idx + 1);
    if (!raw) {
      continue;
    }
    if (kind === 'name') {
      out.names.push(raw);
    } else if (kind === 'artist') {
      out.artists.push(raw);
    } else if (kind === 'set') {
      out.sets.push(raw);
    } else if (kind === 'free') {
      out.free.push(raw);
    }
  }
  return out;
}

function dedupeBySlugExport(entities) {
  const seen = new Set();
  return (entities || []).filter((entity) => {
    const key = entity.slug || entity.compact;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
