/**
 * PIPELINE BLOCK: one free-text scoring model (SPA, pure/shared-capable)
 * --------------------------------------------------------------------
 * The single query-understanding path for ordinary free-text Singles search.
 * Replaces the old fork between resolveSuggestQuery/resolverOwns and
 * parseTypedQuery's destructive set-peeling — two engines whose different
 * typo/fuzzy semantics silently changed the candidate universe.
 *
 * Contract:
 *   tokenize once (non-destructive)
 *     → derive per-token evidence against the active-language doc fields
 *     → score EVERY candidate with ONE model (coverage-first, quality tiebreak)
 *     → rank.
 * Recognition (name / set / artist) only ADDS evidence. It never deletes a
 * token, never turns a fuzzy guess into a hard constraint, and never selects a
 * different candidate pipeline. Hard universe constraints (print bucket, scope,
 * collector-number) stay OUTSIDE this module, applied after ranking.
 *
 * MULTILINGUAL (server-authoritative): the local vocab is English-only, so the
 * derived index carries English evidence. Localized names/sets are authored
 * server-side and arrive on hydrated rows as localized_name / localized_set
 * scoped to the selected search language. docFromPrinting exposes both as
 * language-tagged fields; the SAME token model scores them. Active languages
 * are [selected, en] (just [en] when English is selected) — never every
 * language at once. A selected-language match earns a SMALL bias over English,
 * never a ranking wall, and English stays fully searchable in every language.
 *
 * Revert: suggest-live.js free-text branch back to rank(nameQuery) + tokenPeeled.
 */

import {
  ART_ALIAS_COMPACT,
  NAME_POOL,
  RARITY_ALIAS_COMPACT,
  RARITY_PHRASE_COMPACT,
  compactQuery,
  emissionMultiplier,
  exactSetAlias,
  maxDistance,
  parseCollectorWord,
  prefixEditDistance,
  printingMatchesArtFilter,
  printingMatchesNumberFilter,
  printingMatchesRarityFilter,
  printingMatchesSetFilter,
} from './suggest-rank.js';
import { ARTIST_POOL, SET_POOL, expansionNationality } from './suggest-catalog.js';
import { printBucket } from './print-bucket.js';

// --- Relative scoring weights (documented; no per-card magic) -----------------
// Ordering only; exact values are simple and deliberately coarse.
//
//   coverage  (how many query tokens the candidate satisfies)   DOMINATES
//   quality   (how strong each token's best evidence is)        TIEBREAK 1
//   prior     (catalog popularity)                              TIEBREAK 2
//
// A candidate covering token1+token2 always outranks one covering only token1,
// regardless of popularity. When two candidates cover the same tokens, the one
// whose evidence is stronger (exact name > typo name > set) wins.
export const COVERAGE_UNIT = 1000;
export const QUALITY_UNIT = 10;

// Per-token evidence quality, 0..1. Field-quality model (small + explainable):
//   name        strongest (a card literally titled with your word)
//   collector   extremely specific — an exact printed number is very
//               discriminative, so it sits just under an exact name
//   artist/set  strong contextual evidence
//   rarity/art  supporting evidence
// Name evidence still always beats metadata, so `legend` as a NAME token
// outscores `legend` as a set. Coverage (tokens matched) dominates all of it.
export const Q_NAME_EXACT = 1.0;
export const Q_NAME_PREFIX = 0.7; // query token is a prefix of a name token (pika → Pikachu)
export const Q_NAME_TYPO = 0.5; // scaled by emissionMultiplier(distance)
export const Q_COLLECTOR = 0.9; // exact printed collector number (n, n/m, SH1, 74a)
export const Q_ARTIST_EXACT = 0.6;
export const Q_ARTIST_PREFIX = 0.42;
export const Q_SET_EXACT = 0.5; // literal set-name word, or a set/era alias (hgss, sl)
export const Q_SET_PREFIX = 0.32;
export const Q_SET_TYPO = 0.18;
export const Q_NUMBER = 0.4; // lexical number-field match (weaker than a parsed collector)
export const Q_RARITY = 0.35; // rarity word or alias (sr → secret)
export const Q_ART = 0.35; // illustration / art alias (ir, sir, fa, illustrazione)

// Tight-match preference: when two candidates cover the same tokens equally,
// the one whose name has FEWER leftover (unmatched) tokens is the better match
// (`Pikachu GX` over `Pikachu & Zekrom GX` for `pikachu gx`). A small per-extra
// penalty on quality, so it only breaks quality ties — never overturns coverage.
export const EXTRA_TOKEN_PENALTY = 0.05;

// Selected-language bias: a match in the selected (non-English) language is
// slightly better evidence than the same tier in English. Kept tiny so it only
// breaks otherwise-equal ties — never lifts a weaker reading over a stronger
// one, and never makes English disappear.
export const SELECTED_LANG_BONUS = 0.03;

// Popularity contributes at most this, so it can only break a coverage+quality
// tie — never lift a weaker reading over a stronger one.
export const PRIOR_BONUS_CAP = 0.9;
const PRIOR_REF = 400;

// Tokens this short are meaningful exact lexical tokens (ex / gx / v) but must
// NOT be prefix/typo-expanded — that is exactly how `pika` used to become a set.
export const SHORT_TOKEN_MAX = 2;

// A typo may only COUNT toward coverage when it changes at most this fraction of
// the typed characters. `pakia`→Palkia (1/5) and long two-edit typos
// (`charizard`, 2.5/9) qualify; `palkia`→Pikachu (2.5/6 ≈ 0.42) does not — that
// is a different word, not a typo. Candidate generation still uses the full
// fuzzy cap (recall), so this only stops accidental low-quality matches from
// inflating coverage. Kept as a ratio so it is length-independent.
export const TYPO_COVER_RATIO = 0.34;

function priorBonus(prior) {
  const count = Math.max(1, Number(prior) || 1);
  return Math.min(PRIOR_BONUS_CAP, Math.log1p(count) / Math.log1p(PRIOR_REF) * PRIOR_BONUS_CAP);
}

/** Active search vocabularies: selected language + English (deduped). */
export function activeLanguages(lang) {
  const selected = String(lang || 'en').toLowerCase();
  return selected === 'en' ? ['en'] : [selected, 'en'];
}

/** Split a display string into normalized word tokens, merging possessive 's. */
export function nameTokens(display) {
  const words = String(display || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => compactQuery(word))
    .filter(Boolean);
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

// --- Typed vocabulary recognition (additive; never consumes a token) ---------
// Every curated vocabulary the old resolver/parseTypedQuery owned becomes a
// TYPED interpretation of a query token, carried alongside its always-present
// name reading. Recognition only ADDS evidence — an ambiguous term (`legend`,
// `sl`) keeps every plausible reading and coverage/quality resolves it (§12),
// so we never re-commit early the way the old branch router did.

// Canonical rarity keys the rarity filter understands (secret, ultra, holo, …).
const RARITY_CANON = new Set([...RARITY_ALIAS_COMPACT.values(), ...RARITY_PHRASE_COMPACT.values()]);
// Artist recognition: an exact illustrator name or last-name row → identity.
const ARTIST_BY_COMPACT = new Map();
for (const row of ARTIST_POOL) {
  if (row.compact && !ARTIST_BY_COMPACT.has(row.compact)) {
    ARTIST_BY_COMPACT.set(row.compact, { display: row.display, slug: row.slug || '' });
  }
}

/** Typed interpretations for one token, beyond its always-present name reading. */
function tokenInterps(raw, compact) {
  const interps = [];
  const rarityAlias = RARITY_ALIAS_COMPACT.get(compact);
  if (rarityAlias) {
    interps.push({ field: 'rarity', kind: 'alias', canonical: rarityAlias });
  } else if (RARITY_CANON.has(compact)) {
    interps.push({ field: 'rarity', kind: 'word', canonical: compact });
  }
  const art = ART_ALIAS_COMPACT.get(compact);
  if (art) {
    interps.push({ field: 'art', kind: 'alias', canonical: art });
  }
  const setAlias = compact.length >= 2 ? exactSetAlias(raw) : null;
  if (setAlias?.setNames?.length) {
    interps.push({
      field: 'set',
      kind: 'alias',
      canonical: setAlias.setNames[0],
      setToken: {
        token: raw,
        compact,
        eraId: setAlias.eraId || '',
        setNames: setAlias.setNames,
        needles: setAlias.needles || [compact],
        prefix: false,
        slug: setAlias.slug || '',
      },
    });
  }
  const number = parseCollectorWord(raw);
  if (number) {
    interps.push({ field: 'number', kind: 'collector', canonical: number.token, numberToken: number });
  }
  const artist = ARTIST_BY_COMPACT.get(compact);
  if (artist) {
    interps.push({ field: 'artist', kind: 'exact', canonical: artist.display, slug: artist.slug });
  }
  return interps;
}

/** Non-destructive tokenization: keep every token's raw + normalized form plus
 * its typed interpretations (name is implicit; extras come from vocabulary). */
export function tokenizeQuery(raw) {
  const text = String(raw || '').trim();
  const tokens = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const compact = compactQuery(word);
    if (compact) {
      tokens.push({ raw: word, compact, interps: tokenInterps(word, compact) });
    }
  }
  // Multi-word rarity/art phrases (`secret rare`, `full art`) add a shared
  // interpretation to the spanned tokens without consuming them (§5).
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const canon = RARITY_PHRASE_COMPACT.get(compactQuery(`${tokens[i].raw} ${tokens[i + 1].raw}`));
    if (canon) {
      const field = canon === 'illustration' ? 'art' : 'rarity';
      tokens[i].interps.push({ field, kind: 'phrase', canonical: canon });
      tokens[i + 1].interps.push({ field, kind: 'phrase', canonical: canon });
    }
  }
  return { raw: text, tokens };
}

// --- Derived doc index --------------------------------------------------------
// Each vocab row becomes a doc whose textual evidence is language-scoped:
//   langText: { en: { name:[tokens], set:[tokens], ... }, it: {...}, ... }
// Local vocab is English-only, so local docs carry only `en`. A hydrated Meili
// printing (docFromPrinting) adds the selected language from localized_*.

function makeNameDoc(row) {
  const display = row.display;
  return {
    kind: 'name',
    display,
    compact: row.compact || compactQuery(display),
    prior: Math.max(1, Number(row.prior) || 1),
    slug: row.slug || '',
    langText: { en: { name: nameTokens(display) } },
  };
}

const NAME_DOCS = NAME_POOL.map(makeNameDoc);
const SET_DOCS = SET_POOL.map((row) => ({
  kind: 'set',
  display: row.display,
  compact: row.compact || compactQuery(row.display),
  prior: Math.max(1, Number(row.prior) || 1),
  slug: row.slug || '',
  bucket: printBucket(row.nationality),
  langText: { en: { set: nameTokens(row.display) } },
}));
const ARTIST_DOCS = ARTIST_POOL.map((row) => ({
  kind: 'artist',
  display: row.display,
  compact: row.compact || compactQuery(row.display),
  prior: Math.max(1, Number(row.prior) || 1),
  slug: row.slug || '',
  langText: { en: { artist: nameTokens(row.display) } },
}));

// Inverted token index over English name docs: token -> doc indices. Exact +
// prefix lookups avoid the 10k full scan; fuzzy scans the ~3.7k distinct token
// vocab. Localized candidate generation is the server's job (it matches in the
// selected language and hydrates rows); this index is the deterministic local
// English layer.
const NAME_TOKEN_TO_DOCS = new Map();
for (let i = 0; i < NAME_DOCS.length; i += 1) {
  for (const token of new Set(NAME_DOCS[i].langText.en.name)) {
    let list = NAME_TOKEN_TO_DOCS.get(token);
    if (!list) {
      list = [];
      NAME_TOKEN_TO_DOCS.set(token, list);
    }
    list.push(i);
  }
}
const NAME_TOKEN_LIST = [...NAME_TOKEN_TO_DOCS.keys()].sort();

/** Sorted-vocab prefix range: tokens that start with `prefix`. */
function tokensWithPrefix(prefix) {
  if (!prefix) {
    return [];
  }
  let lo = 0;
  let hi = NAME_TOKEN_LIST.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (NAME_TOKEN_LIST[mid] < prefix) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const out = [];
  for (let i = lo; i < NAME_TOKEN_LIST.length && NAME_TOKEN_LIST[i].startsWith(prefix); i += 1) {
    out.push(NAME_TOKEN_LIST[i]);
    if (out.length >= 400) {
      break;
    }
  }
  return out;
}

/** Distinct name tokens within edit-distance cap of `token` (bounded fuzzy). */
function tokensWithinDistance(token, cap) {
  const out = [];
  const band = Math.ceil(cap) + 1;
  for (const candidate of NAME_TOKEN_LIST) {
    if (Math.abs(candidate.length - token.length) > band) {
      continue;
    }
    const distance = prefixEditDistance(token, candidate);
    if (distance <= cap + 1e-9) {
      out.push({ token: candidate, distance });
    }
  }
  return out;
}

// --- Per-token, per-field evidence -------------------------------------------

/** Best evidence one query token draws from one list of field tokens. */
function fieldEvidence(compact, fieldTokens, tiers) {
  if (!fieldTokens || !fieldTokens.length) {
    return null;
  }
  const short = compact.length <= SHORT_TOKEN_MAX;
  let best = null;
  const consider = (quality, distance, via) => {
    if (!best || quality > best.quality || (quality === best.quality && distance < best.distance)) {
      best = { quality, distance, via };
    }
  };
  for (const fieldToken of fieldTokens) {
    if (fieldToken === compact) {
      consider(tiers.exact, 0, `${tiers.name}-exact`);
    }
  }
  if (best && best.quality >= tiers.exact) {
    return best; // exact is the ceiling for this field.
  }
  if (short) {
    return best; // short tokens: exact lexical evidence only, no expansion.
  }
  if (tiers.prefix) {
    for (const fieldToken of fieldTokens) {
      if (fieldToken.length > compact.length && fieldToken.startsWith(compact)) {
        const extra = fieldToken.length - compact.length;
        consider(tiers.prefix / (1 + 0.03 * extra), extra, `${tiers.name}-prefix`);
      }
    }
  }
  if (tiers.typo) {
    const cap = maxDistance(compact.length);
    if (cap > 0) {
      let bestDistance = Infinity;
      for (const fieldToken of fieldTokens) {
        if (Math.abs(fieldToken.length - compact.length) > Math.ceil(cap) + 1) {
          continue;
        }
        const distance = prefixEditDistance(compact, fieldToken);
        if (distance <= cap + 1e-9 && distance < bestDistance) {
          bestDistance = distance;
        }
      }
      // Only a real typo (few edits per typed char) counts toward coverage.
      if (bestDistance !== Infinity && bestDistance <= compact.length * TYPO_COVER_RATIO + 1e-9) {
        consider(tiers.typo * emissionMultiplier(bestDistance), bestDistance, `${tiers.name}-typo`);
      }
    }
  }
  return best;
}

const NAME_TIERS = { name: 'name', exact: Q_NAME_EXACT, prefix: Q_NAME_PREFIX, typo: Q_NAME_TYPO };
const SET_TIERS = { name: 'set', exact: Q_SET_EXACT, prefix: Q_SET_PREFIX, typo: Q_SET_TYPO };
const ARTIST_TIERS = { name: 'artist', exact: Q_ARTIST_EXACT, prefix: Q_ARTIST_PREFIX, typo: 0 };

/**
 * Best evidence a single query token can draw from one doc, across the active
 * languages. Name tokens beat metadata; a selected-language hit earns a small
 * bias over English. Returns `{ quality, distance, via, lang }` or null.
 */
export function tokenEvidence(token, doc, langs = ['en']) {
  const compact = token.compact;
  if (!compact) {
    return null;
  }
  let best = null;
  const consider = (evidence, lang) => {
    if (!evidence) {
      return;
    }
    const boosted = lang !== 'en' ? evidence.quality * (1 + SELECTED_LANG_BONUS) : evidence.quality;
    if (!best || boosted > best.quality || (boosted === best.quality && evidence.distance < best.distance)) {
      best = {
        quality: boosted,
        distance: evidence.distance,
        via: evidence.via,
        canonical: evidence.canonical || '',
        lang,
      };
    }
  };
  for (const lang of langs) {
    const text = doc.langText?.[lang];
    if (!text) {
      continue;
    }
    consider(fieldEvidence(compact, text.name, NAME_TIERS), lang);
    if (!best || best.quality < Q_SET_EXACT) {
      consider(fieldEvidence(compact, text.set, SET_TIERS), lang);
    }
    if (!best || best.quality < Q_ARTIST_EXACT) {
      consider(fieldEvidence(compact, text.artist, ARTIST_TIERS), lang);
    }
    const number = text.number;
    if (number && (!best || best.quality < Q_NUMBER)
      && (number === compact || (compact.length >= 2 && number.startsWith(compact)))) {
      consider({ quality: Q_NUMBER, distance: 0, via: 'number' }, lang);
    }
    const rarity = text.rarity;
    if (rarity && (!best || best.quality < Q_RARITY) && rarity === compact) {
      consider({ quality: Q_RARITY, distance: 0, via: 'rarity' }, lang);
    }
  }
  // Typed vocabulary evidence: rarity/art/set/collector aliases matched against
  // the hydrated printing through the SAME authoritative filters the legacy
  // path used, so semantics are identical. Each interpretation is considered
  // independently (never one erasing another — §12); applies only to hydrated
  // rows (doc.raw), since local name/artist docs have no such fields.
  if (doc.raw && token.interps?.length) {
    for (const interp of token.interps) {
      if (interp.field === 'rarity' && (!best || best.quality < Q_RARITY)
        && printingMatchesRarityFilter(doc.raw, { rarityTokens: [{ rarity: interp.canonical }] })) {
        consider({ quality: Q_RARITY, distance: 0, via: `rarity-${interp.kind}`, canonical: interp.canonical }, 'en');
      }
      if (interp.field === 'art' && (!best || best.quality < Q_ART)
        && printingMatchesArtFilter(doc.raw, { artTokens: [{ art: interp.canonical }] })) {
        consider({ quality: Q_ART, distance: 0, via: `art-${interp.kind}`, canonical: interp.canonical }, 'en');
      }
      if (interp.field === 'set' && (!best || best.quality < Q_SET_EXACT)
        && printingMatchesSetFilter(doc.raw, {
          setTokens: [interp.setToken],
          eras: interp.setToken.eraId ? [interp.setToken.eraId] : [],
        })) {
        consider({ quality: Q_SET_EXACT, distance: 0, via: 'set-alias', canonical: interp.canonical }, 'en');
      }
      if (interp.field === 'number' && (!best || best.quality < Q_COLLECTOR)
        && printingMatchesNumberFilter(doc.raw, { numberTokens: [interp.numberToken] })) {
        consider({ quality: Q_COLLECTOR, distance: 0, via: 'number-collector', canonical: interp.canonical }, 'en');
      }
    }
  }
  return best;
}

/**
 * Score one doc against tokenized query. coverage counts tokens with ANY
 * evidence; quality sums the best per-token evidence; prior is a bounded nudge.
 */
export function scoreEntry(tokens, doc, langs = ['en']) {
  let coverage = 0;
  let quality = 0;
  let distance = 0;
  const perToken = [];
  for (const token of tokens) {
    const evidence = tokenEvidence(token, doc, langs);
    if (evidence) {
      coverage += 1;
      quality += evidence.quality;
      distance += evidence.distance;
      perToken.push({ token: token.raw, ...evidence });
    } else {
      perToken.push({ token: token.raw, quality: 0, distance: Infinity, via: 'none', lang: '' });
    }
  }
  // Tight-match preference: penalize leftover name tokens (per the tightest
  // active-language name), so a full-name match beats a longer partial one.
  let minNameLen = Infinity;
  for (const lang of langs) {
    const names = doc.langText?.[lang]?.name;
    if (names && names.length) {
      minNameLen = Math.min(minNameLen, names.length);
    }
  }
  const extraTokens = Number.isFinite(minNameLen) ? Math.max(0, minNameLen - coverage) : 0;
  quality -= EXTRA_TOKEN_PENALTY * extraTokens;
  const score = coverage * COVERAGE_UNIT + quality * QUALITY_UNIT + priorBonus(doc.prior);
  return { score, coverage, quality, distance, perToken };
}

// --- Candidate generation + ranking ------------------------------------------

/** Union of English name docs any token can plausibly reach (exact/prefix/typo). */
function candidateNameDocs(tokens) {
  const seen = new Set();
  for (const token of tokens) {
    const compact = token.compact;
    if (!compact) {
      continue;
    }
    for (const index of NAME_TOKEN_TO_DOCS.get(compact) || []) {
      seen.add(index);
    }
    if (compact.length > SHORT_TOKEN_MAX) {
      for (const prefixToken of tokensWithPrefix(compact)) {
        for (const index of NAME_TOKEN_TO_DOCS.get(prefixToken) || []) {
          seen.add(index);
        }
      }
      const cap = maxDistance(compact.length);
      if (cap > 0) {
        for (const hit of tokensWithinDistance(compact, cap)) {
          for (const index of NAME_TOKEN_TO_DOCS.get(hit.token) || []) {
            seen.add(index);
          }
        }
      }
    }
  }
  return [...seen].map((index) => NAME_DOCS[index]);
}

function compareScored(left, right) {
  return right.score - left.score
    || left.compact.length - right.compact.length
    || left.display.localeCompare(right.display);
}

/**
 * Rank the local (English) name vocabulary for a free-text query with the one
 * model. Drop-in for rankNames on NAME_POOL: rows carry { display, compact,
 * prior, score, coverage, distance, withinCap } so group ordering still works.
 * `lang` is accepted for API symmetry; local docs are English, so localized
 * evidence comes from scoreGroups over hydrated rows, not from here.
 */
export function rankFreeText(query, { limit = 48, lang = 'en' } = {}) {
  const { tokens } = tokenizeQuery(query);
  if (!tokens.length) {
    return [];
  }
  const langs = activeLanguages(lang);
  const docs = candidateNameDocs(tokens);
  const ranked = [];
  for (const doc of docs) {
    const scored = scoreEntry(tokens, doc, langs);
    if (scored.coverage === 0) {
      continue;
    }
    ranked.push({
      display: doc.display,
      compact: doc.compact,
      prior: doc.prior,
      kind: 'name',
      slug: '',
      score: scored.score,
      coverage: scored.coverage,
      quality: scored.quality,
      distance: scored.distance,
      withinCap: true,
    });
  }
  ranked.sort(compareScored);
  return ranked.slice(0, Math.max(1, Number(limit) || 48));
}

/** Map a hydrated Meili printing into the shared, language-tagged doc shape. */
export function docFromPrinting(printing = {}, { lang = 'en' } = {}) {
  const display = printing.name || '';
  const set = printing.set_name || printing.set || printing.expansion_name || '';
  const number = compactQuery(printing.collector_number || printing.number || printing.card_number || '');
  const langText = {
    en: {
      name: nameTokens(display),
      set: nameTokens(set),
      artist: nameTokens(printing.artist || ''),
      number,
      rarity: compactQuery(printing.rarity || ''),
    },
  };
  const selected = String(lang || 'en').toLowerCase();
  // Localized_* fields are language-tainted cache data: they hold whatever
  // language the row was last fetched under. Trust them only when the row was
  // stamped with the active language (see rememberSuggestGroups). An unstamped
  // row (legacy path) is trusted too, but a row stamped for a DIFFERENT
  // language is ignored — this also drops a stale cross-language response.
  const rowLang = String(printing.search_lang || '').toLowerCase();
  const langMatches = !rowLang || rowLang === selected;
  if (selected !== 'en' && langMatches) {
    const localizedName = printing.localized_name || printing.localizedName || '';
    const localizedSet = printing.localized_set || printing.localizedSet || '';
    const localizedRarity = printing.localized_rarity || printing.localizedRarity || '';
    if (localizedName || localizedSet || localizedRarity) {
      langText[selected] = {
        name: nameTokens(localizedName),
        set: nameTokens(localizedSet),
        number,
        rarity: compactQuery(localizedRarity),
      };
    }
  }
  return {
    kind: 'printing',
    display,
    compact: compactQuery(display),
    prior: Math.max(1, Number(printing.prior) || 1),
    id: String(printing.id || printing.card_id || ''),
    bucket: printBucket(printing.nationality) || (set ? printBucket(expansionNationality(set)) : 'unknown'),
    langText,
    // Raw row for the authoritative rarity/art/set/collector filters (typed
    // evidence reuses the legacy matchers rather than re-implementing them).
    raw: printing,
  };
}

/**
 * Score suggest groups (each { name, printings }) with the unified model under
 * the active languages, and return them ordered by best-printing score plus a
 * name->score map. This is where server-hydrated localized rows enter ranking,
 * with the SAME token model — deterministically, independent of arrival order.
 */
export function scoreGroups(query, groups, { lang = 'en', minCoverage = 1 } = {}) {
  const { tokens } = tokenizeQuery(query);
  const langs = activeLanguages(lang);
  const scoreByName = new Map();
  const scored = [];
  for (const group of groups || []) {
    // Score every printing, then reorder the group's printings by their own
    // evidence so the strongest reading leads (`eevee i` → the Illustration
    // Rare first; `charizard sr` → the Secret Rare). One scorer owns both the
    // group order and the within-group order — no separate art/number sort.
    const rows = (group.printings || []).map((printing) => ({
      printing,
      result: scoreEntry(tokens, docFromPrinting(printing, { lang }), langs),
    }));
    rows.sort((a, b) => b.result.score - a.result.score);
    let best = rows[0]?.result || null;
    if (!best) {
      // No printings yet (stub / cold cache): fall back to the group name as an
      // English doc so instant paint still orders by coverage.
      best = scoreEntry(tokens, makeNameDoc({ display: group.name, prior: 1 }), langs);
    }
    if (best.coverage < minCoverage) {
      continue;
    }
    const ordered = rows.length ? { ...group, printings: rows.map((row) => row.printing) } : group;
    scoreByName.set(compactQuery(group.name), best.score);
    scored.push({ group: ordered, score: best.score, coverage: best.coverage });
  }
  scored.sort((a, b) => (
    b.score - a.score
    || String(a.group.name || '').localeCompare(String(b.group.name || ''))
  ));
  return { groups: scored.map((row) => row.group), scoreByName };
}

/**
 * Debug/test-only: human-readable explanation of why a display (or a hydrated
 * printing) scores as it does for a query, in the active languages.
 */
export function explainQuery(query, target, { lang = 'en' } = {}) {
  const { tokens } = tokenizeQuery(query);
  const langs = activeLanguages(lang);
  const doc = typeof target === 'string'
    ? makeNameDoc({ display: target, prior: 1 })
    : docFromPrinting(target, { lang });
  const scored = scoreEntry(tokens, doc, langs);
  const lines = [typeof target === 'string' ? target : (target.name || ''), `  langs = [${langs.join(', ')}]`, ''];
  for (const row of scored.perToken) {
    lines.push(`  ${row.token}: via=${row.via}${row.canonical ? ` canonical="${row.canonical}"` : ''}`
      + `${row.lang ? ` lang=${row.lang}` : ''} quality=${row.quality.toFixed(3)}`
      + `${Number.isFinite(row.distance) ? ` distance=${row.distance}` : ''}`);
  }
  lines.push('');
  lines.push(`  coverage = ${scored.coverage}/${tokens.length}`);
  lines.push(`  quality  = ${scored.quality.toFixed(3)}`);
  lines.push(`  score    = ${scored.score.toFixed(3)}`);
  return { text: lines.join('\n'), ...scored };
}

export const __index = { NAME_DOCS, SET_DOCS, ARTIST_DOCS, NAME_TOKEN_LIST };
