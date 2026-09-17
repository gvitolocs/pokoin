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
  MIN_BARE_SET_PREFIX,
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
import { suggestKind } from './identity.js';

/** Sealed-product titles prefix-reading as a rewrite (`mewtwo` → the deck kit). */
function productTitleRewrite(display) {
  return suggestKind({ name: display }, display) === 'Product' ? 1 : 0;
}

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

/** Merge possessive fragments: "N's Zoroark" → [ns, zoroark], not [n, s, …]. */
function possessiveWords(display) {
  const words = splitWords(display);
  const merged = [];
  for (const word of words) {
    if (word === 's' && merged.length) {
      merged[merged.length - 1] += 's';
      continue;
    }
    merged.push(word);
  }
  return merged;
}

/** Unified entity vocabulary: names + artists (+ their last-name rows) + set titles. */
const VOCAB = [
  ...NAME_POOL.map((row) => ({
    kind: 'name',
    display: row.display,
    compact: row.compact,
    words: possessiveWords(row.display),
    prior: row.prior,
    slug: '',
  })),
  ...ARTIST_POOL.map((row) => ({
    kind: 'artist',
    display: row.display,
    compact: row.compact,
    words: possessiveWords(row.display),
    prior: row.prior,
    slug: row.slug || '',
  })),
  ...SET_POOL.map((row) => ({
    kind: 'set',
    display: row.display,
    compact: row.compact,
    words: possessiveWords(row.display),
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

/**
 * Word index over multi-word entities: gapped literal projections
 * (`palkia legend` → Palkia & Dialga LEGEND) need entities containing the
 * span words in order, not just as a contiguous prefix.
 */
const WORD_INDEX = new Map();
for (const entry of VOCAB) {
  if (entry.words.length < 2) {
    continue;
  }
  for (const word of new Set(entry.words)) {
    let list = WORD_INDEX.get(word);
    if (!list) {
      list = [];
      WORD_INDEX.set(word, list);
    }
    list.push(entry);
  }
}

function wordMatches(typed, entityWord) {
  // Possessive tolerance: `n` matches the `n's` title word, `imakuni` the
  // `imakuni?'s` word — the apostrophe-s never survives compaction.
  return typed === entityWord || (typed.length >= 1 && entityWord === typed + 's');
}

function isSubsequence(spanWords, entityWords) {
  let at = 0;
  let exactWords = 0;
  for (const word of entityWords) {
    if (at < spanWords.length && wordMatches(spanWords[at], word)) {
      // A possessive title word (`imakuni?` + `'s` → `imakunis`) typed as its
      // base form is still exact evidence of that title word.
      if (word === spanWords[at] || spanWords[at] + 's' === word) {
        exactWords += 1;
      }
      at += 1;
      if (at === spanWords.length) {
        break;
      }
    }
  }
  if (at !== spanWords.length) {
    return null;
  }
  // Every typed word literally present in the title (possessive-s aside) is
  // exact evidence; one prefix word makes the whole projection a prefix.
  return { exact: exactWords === spanWords.length };
}

/** Order-insensitive fallback: every typed word appears (once) in the title. */
function isMultisetContained(spanWords, entityWords) {
  const pool = [...entityWords];
  let exactWords = 0;
  for (const typed of spanWords) {
    const exactAt = pool.indexOf(typed);
    if (exactAt >= 0) {
      pool.splice(exactAt, 1);
      exactWords += 1;
      continue;
    }
    const possessiveAt = pool.indexOf(typed + 's');
    if (possessiveAt >= 0) {
      pool.splice(possessiveAt, 1);
      exactWords += 1;
      continue;
    }
    return null;
  }
  return { exact: exactWords === spanWords.length };
}

function subsequenceCandidates(comps, start, end) {
  const spanWords = comps.slice(start, end + 1);
  if (spanWords.length < 2) {
    return [];
  }
  // Constituent order is not semantic: `mew mewtwo` titles the same card as
  // `mewtwo mew`, so probe the reversed span too.
  const probes = [spanWords, [...spanWords].reverse()];
  const out = [];
  const seenEntries = new Set();
  for (const probe of probes) {
    // Possessive tolerance at index time too: `n` must probe `n's`-keyed titles.
    const head = WORD_INDEX.get(probe[0]) || [];
    const possessive = probe[0].length >= 1 ? WORD_INDEX.get(probe[0] + 's') || [] : [];
    let entries = [...head, ...possessive.filter((entry) => !head.includes(entry))];
    if (entries.length < 4) {
      const second = WORD_INDEX.get(probe[1]);
      if (second?.length) {
        entries = [...entries, ...second.filter((entry) => !entries.includes(entry))];
      }
    }
    for (const entry of entries) {
      if (out.length >= 6) {
        break;
      }
      if (seenEntries.has(entry.compact)) {
        continue;
      }
      const match = isSubsequence(probe, entry.words) || isMultisetContained(probe, entry.words);
      if (!match) {
        continue;
      }
      seenEntries.add(entry.compact);
      out.push({
        ...entry,
        // Each untyped middle word is a literal gap in the projection.
        distance: entry.words.length - spanWords.length,
        exactness: match.exact ? 'exact' : 'prefix',
        // Evidence-complete literal projection: every typed word appears
        // verbatim in one title, so it prices like an exact span and can beat
        // splitting the same tokens across two unrelated cards.
        costOverride: match.exact ? 0 : 0.25,
      });
    }
  }
  return out;
}

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
    // Short codes, expansion-prefix and homonym readings are semantic
    // rewrites of what the user typed — literal readings outrank them.
    rewrites: 1,
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
  if (candidate.costOverride != null) {
    return candidate.costOverride;
  }
  // The semantic-rewrite price rides INSIDE cost: an exact homonym alias
  // (legend → Call of Legends, +0.5) loses to an exact literal reading but
  // beats a bare prefix guess (0.25) — so bare `legend` still browses CoL.
  const rewritePrice = (candidate.rewrites || 0) * 0.5;
  if (candidate.exactness === 'exact') {
    return candidate.distance + rewritePrice;
  }
  if (candidate.exactness === 'prefix') {
    return 0.25 + candidate.distance + rewritePrice;
  }
  // A capped fuzzy hit must still beat leaving the token unresolved.
  return 0.75 + candidate.distance * 0.1 + rewritePrice;
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
    const exactness = labelExactness({ distance, compact: entry.compact }, spanCompactText);
    out.push({
      ...entry,
      distance,
      // A prefix reading is the expansion-prefix rewrite when the entity is a
      // set or a sealed-product title (`mewtwo` → the deck kit, `pika` →
      // Pikachu World Collection); a species prefix (`pika` → Pikachu) is
      // literal evidence.
      rewrites: exactness !== 'exact' && (entry.kind === 'set' || productTitleRewrite(entry.display)) ? 1 : 0,
      exactness,
    });
  }
  // Gapped literal projections (`palkia legend` → Palkia & Dialga LEGEND):
  // every typed word appears in the title, in order. Flat cheap cost so one
  // compound-title reading beats two independent prefix guesses, capped at
  // two skipped words before the gap starts costing.
  for (const entry of subsequenceCandidates(comps, start, end)) {
    out.push({
      ...entry,
      rewrites: entry.kind === 'set' && entry.exactness !== 'exact' ? 1 : 0,
      costOverride: 0.25 + Math.max(0, entry.distance - 2) * 0.5,
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
        words: possessiveWords(row.display),
        prior: row.prior,
        slug: VOCAB_BY_COMPACT.get(row.compact)?.slug || '',
        distance: row.distance,
        rewrites: 0,
        exactness: labelExactness(row, spanCompactText),
      });
    }
  }
  const ranked = dedupeCandidates(out)
    .sort((left, right) => (
      (left.rewrites - right.rewrites)
      || (candidateCost(left) - candidateCost(right))
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
      rewrites: 0,
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
    rewrites: 0,
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
              rewrites: state.rewrites + (candidate.rewrites || 0),
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
        rewrites: state.rewrites,
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
    const rewrites = state.rewrites || 0;
    const literalTokens = spans
      .filter((span) => !(span.candidate.rewrites || 0))
      .reduce((n, span) => n + (span.end - span.start + 1), 0);
    const coverage = locked ? 1 : Math.min(1,
      (coveredTokens(state) + state.free.length + protectedCount) / Math.max(1, comps.length));
    return {
      spans,
      free: state.free.map((row) => ({
        ...row,
        raw: words.find((word) => compactQuery(word) === row.comp) || row.comp,
      })),
      entities,
      cost: state.cost + compat,
      coverage,
      rewrites,
      literalCoverage: locked ? 1 : Math.min(1, (literalTokens + protectedCount) / Math.max(1, comps.length)),
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
    // spans so downstream set filters (printingMatchesSetFilter) keep working.
    // The legacy peel is preserved for the semantic-competition gate.
    legacySetTokens: guard.parsed.setTokens || [],
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
    // Paint tiers: winning interpretation first, then distinct alternate
    // readings in comparator order (literal → alias → reduced), then the
    // strongest single entity. Legacy stays the terminal fallback.
    tiers: best ? buildTiers(hypotheses) : [],
    correctedQuery: nameQuery,
    freeText: best ? best.free.map((row) => row.raw) : words,
    parsed,
    hasArtist: Boolean(best?.entities.artist.length),
    hasSet: Boolean(best?.entities.set.length),
  };
}

function compareHypotheses(left, right) {
  // Cost already carries the semantic-rewrite price; rewrites remain a
  // tiebreak. When two readings tie all the way down, the one that binds the
  // same typed tokens onto FEWER entities wins — one card literally titled
  // with your words beats two cards each covering half of them.
  return right.coverage - left.coverage
    || left.cost - right.cost
    || left.rewrites - right.rewrites
    || left.compat - right.compat
    || entityCountOf(left) - entityCountOf(right)
    || left.exactnessRank - right.exactnessRank
    || left.kindRank - right.kindRank
    || right.popularity - left.popularity;
}

function entityCountOf(hypothesis) {
  // Free tokens count as unresolved "entities" — an all-free reading must
  // never outrank an entity span on this tiebreak.
  return hypothesis.entities.name.length
    + hypothesis.entities.artist.length
    + hypothesis.entities.set.length
    + hypothesis.free.length;
}

function signatureOf(hypothesis) {
  // Shape signature: same-kind readings with different entities (Yuka Morii
  // vs Yuka Tanaka) are popularity rivals inside one tier, not alternate
  // readings. A tier is a different SHAPE of interpretation.
  return hypothesis.spans.map((span) => span.candidate.kind).join(',') + '|' + hypothesis.free.length;
}

/**
 * Paint tiers: the winning hypothesis, then each further hypothesis whose
 * interpretation shape differs (literal → alias → reduced), capped so the
 * popup degrades through at most three readings before the legacy fallback.
 */
function buildTiers(hypotheses) {
  const tiers = [];
  const seen = new Set();
  for (const hypothesis of hypotheses) {
    const signature = signatureOf(hypothesis);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    tiers.push(hypothesis);
    if (tiers.length >= 3) {
      break;
    }
  }
  const best = tiers[0];
  if (best && best.spans.length > 1) {
    // Strongest single entity as the final relaxation for name+artist pairs.
    const single = [...best.spans].sort((left, right) => (
      candidateCost(left.candidate) - candidateCost(right.candidate)
      || right.candidate.prior - left.candidate.prior
    ))[0];
    const singleEntities = entityMap([single]);
    const singleSignature = single.candidate.kind + '|0';
    if (!seen.has(singleSignature)) {
      seen.add(singleSignature);
      tiers.push({
        ...best,
        spans: [single],
        entities: singleEntities,
      });
    }
  }
  return tiers;
}

export function resetResolveMemo() {
  resolveMemo.clear();
  spanMemo.clear();
}

/**
 * Semantic competition, narrowly: legacy peeled a set, but the winning
 * reading is a single compound-name literal projection covering every token
 * (`palkia legend` → Palkia & Dialga LEGEND). Two-entity glue (`hgss
 * energy`), single-token queries, alias winners (`palkia sl`) and fuzzy
 * readings stay legacy.
 */
export function resolverOwns(resolved) {
  const best = resolved?.best;
  if (!best) {
    return false;
  }
  if (best.entities.artist.length) {
    return true;
  }
  // D00004M: a bare long expansion-title token is a set browse — the literal
  // projection (Expedition Uniform) must not steal the explicit set intent.
  if (!best.locked
    && best.entities.set.length === 0
    && resolved.query
    && compactQuery(resolved.query).length >= MIN_BARE_SET_PREFIX
    && !namePoolHasCompact(compactQuery(resolved.query))
    && exactSetAlias(resolved.query)) {
    return false;
  }
  if (best.locked || best.rewrites > 0 || best.free.length || best.coverage < 1) {
    return false;
  }
  if (best.entities.set.length || best.entities.artist.length || best.entities.name.length !== 1) {
    return false;
  }
  const [nameEntity] = best.entities.name;
  if (!nameEntity || nameEntity.words.length < 2) {
    return false;
  }
  const legacyPeels = (resolved.parsed.legacySetTokens || []).length > 0;
  const alternate = resolved.hypotheses[1];
  return Boolean(legacyPeels && alternate);
}

/**
 * Serialize the hypothesis for the results page. When the resolver owns the
 * query the winning entities are serialized (Enter on `palkia legend` must
 * NOT set a Call of Legends filter). When legacy owns it, only its confirmed
 * set peel rides along (`palkia sl` → set:Call of Legends).
 */
export function serializeResolution(resolved) {
  const best = resolved?.best;
  if (!best) {
    return '';
  }
  const parts = [];
  const owned = resolverOwns(resolved);
  if (owned || best.locked) {
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
  }
  // Winning set bindings always ride (the page's set filter understands
  // display names); a legacy peel rides only when the resolver did not win —
  // Enter on `palkia legend` must NOT set a Call of Legends filter.
  for (const entity of dedupeBySlugExport(best.entities.set)) {
    parts.push(`set:${entity.display}`);
  }
  if (!best.entities.set.length && !owned) {
    for (const token of resolved.parsed?.legacySetTokens || []) {
      const display = token.setNames?.[0] || token.token;
      if (display) {
        parts.push(`set:${display}`);
      }
    }
  }
  if (!parts.length && owned && best.free.length) {
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
