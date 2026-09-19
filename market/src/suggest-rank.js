/**
 * PIPELINE BLOCK: typeahead name rank (SPA)
 * -----------------------------------------
 * Meili still hydrates printings (`GET /api/marketplace-suggest`). Ranking is
 * a compact name pool scored as P(name|query) ∝ emission × (2 popularity +
 * 4 perfect mechanic match) — not Flutter
 * `marketplace-autocomplete` and not `searchbar-token-predict` (those are
 * prefix-only: `oi` → Oinkologne, `dawe` empty).
 *
 * Emission is prefix Damerau-Levenshtein: exact 0, QWERTY-adjacent / adjacent
 * transpose 0.5, far/indel 1. Length 1–3 allows keyboard only; 4–5 one far typo
 * (`dawe` → Dawn); 6+ two skipped letters plus an adjacent key (`talflamd` →
 * Talonflame). Untyped name suffix is cheap so `o` then `oi` can promote Pikachu.
 * The **whole compact name** scores against unique blueprint names
 * (`marketplace_card_names`); `miikyu ex` → `mimikyuex` is one name, not a
 * peeled EX layer. An exact mechanic *word* (`gx` / `ex` / `v` / `vmax` /
 * `vstar`) still has to beat base-species prior: `pikahc gx` → Pikachu GX.
 * Popularity is **2 points** (log printing count, capped); a perfect
 * mechanic-word match is **4**. Do not multiply by 428 printings. Reddit species
 * typos are a regression suite, not exact aliases (`Garados` is official
 * German Gyarados).
 *
 * Multi-word queries peel set tokens (exact extras like `hgss`, short codes
 * like `sl` → Call of Legends, long set names like `generations`, typos like
 * `geenration`, phrases like `call of legendsd` or the exact prefix
 * `call of`, and a typed expansion prefix longer than 3 letters —
 * `plasma` → Plasma Storm / Freeze / Blast first, then the rest of that
 * name pool to fill 20 singles). A **bare** expansion-title token (`expedition`)
 * is a set browse: 20 singles from that expansion, not the longer card-name
 * prefix (Expedition Uniform). An exact blueprint name never peels as a
 * fuzzy set title: `eevee i` keeps the Eevee pool even though SWSH
 * `Eevee Heroes` extends `eevee`. Mechanic words (`vmax` / `mega` / `gx`) stay on the card. Collector n / n/m (`061` / `061/106`), letter-prefix collectors
 * (`Sh1` / `SH12` / `TG01`), and art/rarity shorthands (`i` / `il` / `ill` / `ir` / `sir` /
 * `fa` / `illustrazione` → illustration/full-art) then rank the leftover name
 * (`elafon` → Leafeon, `flareon call of legendsd` → Flareon,
 * `061 shieldon` → Shieldon, `sylveon ex il` → Sylveon ex, `palkai sl` /
 * `palkia legen` → Palkia in Call of Legends, then the rest of that name
 * pool to fill 20 singles). Pair names keep the mechanic: `Palkia & Dialga
 * Legend` is Palkia & Dialga LEGEND, not Paldea + Call of Legends Dialga.
 * Solo `Lugia LEGEND` / `Ho-Oh LEGEND` keep LEGEND on the name. Tag Team GX
 * pairs keep `tag team`. BREAK / LV.X / V-UNION / δ Delta Species / Prism Star
 * / Gold Star stay on the card name; `palkia legen` without `&` still peels
 * Call of Legends. Compact ranking strips the δ glyph so `pikachu delta
 * species` matches `Pikachu δ Delta Species`. Meili hydrates the typed name
 * immediately — rank workers must not block that (they each import the name
 * catalog). `Sh1` is both the SH1/SH10 collector prefix and
 * a name typo (Shinx, Shuppet). Collector hits stay first. The print-language
 * chip then keeps western (or JP/KO/CN) rows. `061 shieldon` still queries the
 * name so Potion 061/073 cannot win. Do not peel leftover `ex` as Expedition,
 * and do not peel set `151` as a collector. The popup takes the top 20 real
 * printings from the ranked name pool — never live: name stubs to pad, and
 * never a singles tab emptied by Paldea Legends tins or Jumbo Oversized.
 * Suggest
 * Meili stays name + number + nicknames — do not put `expansion_aliases` on
 * typeahead search-on.
 *
 * `2pikabench` is one bench of 10 names: drop two letters and swap one remaining
 * key (`seed=2`). It records `rank_ms` (pool) and `search_ms` (`fetchSuggestRanked`).
 *
 * Revert: Chrome.jsx `fetchSuggest` only, min 2 chars.
 */

import RAW_NAMES from './data/suggest-names.js';
import RAW_SETS from './data/suggest-sets.js';
import { suggestKind } from './identity.js';
import { effectivePrintBucket, printLangMatchesBucket } from './print-bucket.js';
import { TCG_ERA_CATALOG, matchTcgEra } from './tcg-eras.js';

export const KEYBOARD_COST = 0.5;
export const FAR_COST = 1;
export const INDEL_COST = 1;
/** Adjacent letter swap (`elafon` → Leafeon). Same weight as a neighbor key. */
export const TRANSPOSE_COST = KEYBOARD_COST;
/** Two skipped letters (insertions into the query) plus one QWERTY neighbor. */
export const TWO_INSERT_KEYBOARD_COST = 2 * FAR_COST + KEYBOARD_COST;
export const SUGGEST_RESULT_FLOOR = 20;
export const SUGGEST_NAME_LOOKUPS = 6;
export const RANK_FILL = 48;
/** exp(-λ × 0.5) ≈ 0.12 so keyboard `o` stays below exact-prefix Onix. */
export const DISTANCE_LAMBDA = 4.236;
/** Catalog frequency is at most this many points, never raw printing count (428). */
export const POPULARITY_POINTS = 2;
/** Exact typed mechanic word (`gx` / `ex` / `v` / …) on the name. */
export const PERFECT_MATCH_POINTS = 4;
/** log1p(prior) saturates here so Pikachu (428) is 2 points, not 428×. */
export const POPULARITY_PRIOR_REF = 400;
/** Unmatched name suffix. Strong on short queries (`dawe` → Dawn, not Dwebble).
 * Tiny from length 6 so two skipped letters still prefer Talonflame over Gallade. */
export const SUFFIX_K = 0.75;
export const SUFFIX_K_LONG = 0.04;

function suffixWeight(queryLength) {
  return Number(queryLength) <= 5 ? SUFFIX_K : SUFFIX_K_LONG;
}

const KEY_NEIGHBORS = {
  q: 'wa',
  w: 'qeas',
  e: 'wrsd',
  r: 'etdf',
  t: 'ryfg',
  y: 'tugh',
  u: 'yihj',
  i: 'uojk',
  o: 'ipkl',
  p: 'ol',
  a: 'qwsz',
  s: 'awedxz',
  d: 'serfcx',
  f: 'drtgvc',
  g: 'ftyhbv',
  h: 'gyujnb',
  j: 'huiknm',
  k: 'jiolm',
  l: 'kop',
  z: 'asx',
  x: 'zsdc',
  c: 'xdfv',
  v: 'cfgb',
  b: 'vghn',
  n: 'bhjm',
  m: 'njk',
  '1': '2q',
  '2': '13qw',
  '3': '24we',
  '4': '35er',
  '5': '46rt',
  '6': '57ty',
  '7': '68yu',
  '8': '79ui',
  '9': '80io',
  '0': '9op',
};

export function compactQuery(value) {
  // Unicode-safe compaction shared across search / suggest / cache keys.
  // Order matters: NFKC folds full-width/compatibility and composes; strip
  // Greek delta (delta-species shorthand); NFD exposes Latin diacritics as
  // trailing combining marks; strip ONLY U+0300-U+036F so `é`->`e` while
  // Japanese dakuten/handakuten (U+3099/U+309A, outside that range) survive;
  // NFC recomposes voiced kana; then casefold and drop non-letter/number.
  // Invariant: NFC and NFD forms of the same string collapse to one compact,
  // but distinct kana stay distinct (compactQuery("ピ") !== compactQuery("ヒ")).
  return String(value || "")
    .normalize("NFKC")
    .replace(/[δΔ]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function nameRow(display, prior = 1) {
  const text = String(display || '').trim();
  return {
    display: text,
    compact: compactQuery(text),
    prior: Math.max(1, Number(prior) || 1),
  };
}

const MODIFIER_NAME = /\b(ex|gx|v|vmax|vstar|v-?union|mega|lv\.?\s*[x\d]+|tag team|legend|break|delta|prime|prism star|gold star)\b/i;
/** Longest first so `vmax` is not read as `v`. Not set/rarity peels — leftover `ex` stays blocked. */
const MODIFIER_COMPACT = [
  'vmax', 'vstar', 'vunion', 'tagteam', 'legend', 'break', 'lvx', 'delta',
  'prime', 'mega', 'gx', 'ex', 'v',
];
const MODIFIER_WORD = new Set(MODIFIER_COMPACT);
const PAIR_JOIN_RE = /^(?:&|and)$/i;

/** Mechanic words (`gx` / `vmax` / `mega`) for the protected-syntax pass. */
export function isModifierWord(word) {
  return MODIFIER_WORD.has(compactQuery(word));
}

/** Exact blueprint-name check (`eevee` beats an `Eevee`-titled expansion alias). */
export function namePoolHasCompact(compact) {
  const key = String(compact || '');
  return Boolean(key) && NAME_POOL.some((row) => row.compact === key);
}

/** Exact expansion alias (`hgss`, `sl`), or null. Read-only view for the resolver. */
export function exactSetAlias(word) {
  return expansionAliasIndex().get(compactQuery(word)) || null;
}

/** Expansion-title prefix candidate (`pika` → Pikachu World Collection), or null. */
export function expansionPrefixSet(word) {
  return packedFromExpansionPrefix(compactQuery(word));
}

/** Best fuzzy set-alias hit for a token (`call of legendsd` family), or null. */
export function rankedSetAlias(word) {
  return rankNames(word, setAliasPool())[0] || null;
}

function popularityPoints(prior) {
  const count = Math.max(1, Number(prior) || 1);
  const scaled = POPULARITY_POINTS
    * Math.log1p(count)
    / Math.log1p(POPULARITY_PRIOR_REF);
  return Math.min(POPULARITY_POINTS, scaled);
}

function perfectMatchPoints(display, mods) {
  if (!mods?.length) {
    return 0;
  }
  if (mods.every((mod) => displayHasModifier(display, mod))) {
    return PERFECT_MATCH_POINTS;
  }
  return 0;
}

function displayHasModifier(display, mod) {
  const text = String(display || '');
  if (mod === 'v') {
    return /(^|[\s&])v(?!\s*(max|star))/i.test(text);
  }
  if (mod === 'tagteam') {
    return /tag\s*team/i.test(text);
  }
  if (mod === 'legend') {
    return /\blegend\b/i.test(text) && !/call of legends|shining legends|hidden legends/i.test(text);
  }
  if (mod === 'break') {
    return /\bbreak\b/i.test(text) && !/breakthrough|breakpoint/i.test(text);
  }
  if (mod === 'lvx') {
    return /lv\.?\s*x\b/i.test(text);
  }
  if (mod === 'vunion') {
    return /v[\s-]*union/i.test(text);
  }
  if (mod === 'delta') {
    return /delta\s*species|\u03b4/i.test(text);
  }
  if (mod === 'prime') {
    return /\bprime\b/i.test(text) && !/primeape|prime catcher/i.test(text);
  }
  if (mod === 'mega') {
    return /\bmega\b/i.test(text);
  }
  return new RegExp(`\\b${mod}\\b`, 'i').test(text);
}

/** GX when the query is `ex`, VMAX when the query is `v`. Base species is not a rival. */
export function hasRivalMechanic(display, mods = []) {
  if (!mods?.length) {
    return false;
  }
  const present = MODIFIER_COMPACT.filter((token) => displayHasModifier(display, token));
  if (!present.length) {
    return false;
  }
  return !present.some((token) => mods.includes(token));
}

export function typedModifiers(query) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  const mods = [];
  const nameWords = [];
  for (const word of words) {
    const compact = compactQuery(word);
    if (MODIFIER_WORD.has(compact)) {
      mods.push(compact);
    } else {
      nameWords.push(word);
    }
  }
  if (!mods.length) {
    const full = compactQuery(query);
    for (const token of MODIFIER_COMPACT) {
      if (full.length > token.length + 2 && full.endsWith(token)) {
        mods.push(token);
        break;
      }
    }
  }
  return {
    mods,
    nameCompact: compactQuery(nameWords.join(' ')),
  };
}

function modifierPenalty(display, queryCompact = '', mods = []) {
  if (mods?.length) {
    return 1;
  }
  if (!MODIFIER_NAME.test(String(display || ''))) {
    return 1;
  }
  const compact = String(queryCompact || '');
  if (/\bex\b/i.test(display) && /ex$/.test(compact) && compact.length > 3) {
    return 1;
  }
  if (/\bgx\b/i.test(display) && /gx$/.test(compact) && compact.length > 3) {
    return 1;
  }
  return 0.05;
}

/** Collector slang + title-language rarity labels. Not EX/GX (those are names). */
export const ART_ALIAS_COMPACT = new Map([
  ['il', 'illustration'],
  ['i', 'illustration'],
  ['ill', 'illustration'],
  ['illu', 'illustration'],
  ['illust', 'illustration'],
  ['illustra', 'illustration'],
  ['illustrat', 'illustration'],
  ['illustratio', 'illustration'],
  ['illus', 'illustration'],
  ['illustration', 'illustration'],
  ['illustrazione', 'illustration'],
  ['illustrationrare', 'illustration'],
  ['specialillustration', 'illustration'],
  ['specialillustrationrare', 'illustration'],
  ['ir', 'illustration'],
  ['sir', 'illustration'],
  ['fa', 'illustration'],
  ['fullart', 'illustration'],
  ['ar', 'illustration'],
  ['sar', 'illustration'],
  ['artrare', 'illustration'],
  ['raraillustrazione', 'illustration'],
  ['rarailustracion', 'illustration'],
  ['illustrationspecialerare', 'illustration'],
  ['seltenillustration', 'illustration'],
  ['seltenbesondereillustration', 'illustration'],
]);

const ART_PRINTING_RE = /illustration|full\s*art|full-art|fullart|art rare|special art|special illustration|illustrazione|ilustraci[oó]n|besondere illustration/i;

export function isArtAwareQuery(parsed) {
  return Boolean(parsed?.artTokens?.length);
}

/** Printed collector n, n/m, or 74a — not 4+ digit catalog ids. */
const COLLECTOR_WORD_RE = /^#?(\d{1,3})(?:\/(\d{1,4}))?([a-z])?$/i;
/** SH1, SH12, TG01 — not `shi`, not set `151`. */
const CODE_COLLECTOR_RE = /^#?([a-z]{1,5})(\d{1,3})(?:\/(\d{1,4}))?$/i;
const CODE_IN_NUMBER_RE = /([a-z]{1,5})(\d{1,3})(?:\s*\/\s*(\d{1,4}))?/i;

export function parseCollectorWord(word) {
  const raw = String(word || '').trim();
  const match = raw.match(COLLECTOR_WORD_RE);
  if (match) {
    return {
      kind: 'number',
      token: word,
      compact: compactQuery(raw.replace(/^#/, '')),
      n: Number(match[1]),
      d: match[2] ? Number(match[2]) : null,
      suffix: (match[3] || '').toLowerCase(),
      code: '',
    };
  }
  const coded = raw.match(CODE_COLLECTOR_RE);
  if (!coded) {
    return null;
  }
  const code = coded[1].toLowerCase();
  return {
    kind: 'number',
    token: word,
    compact: compactQuery(`${code}${coded[2]}`),
    n: Number(coded[2]),
    d: coded[3] ? Number(coded[3]) : null,
    suffix: '',
    code,
  };
}

export const RARITY_PHRASE_COMPACT = new Map([
  ['secretrare', 'secret'],
  ['ultrarare', 'ultra'],
  ['holorare', 'holo'],
  ['reverseholo', 'reverse'],
  ['hyperrare', 'hyper'],
  ['fullart', 'illustration'],
]);

/** Collector slang standing for one version rarity, same score path as the
 * two-word phrases. Same tier letters as the art shorthands (ir/sir/ar). */
export const RARITY_ALIAS_COMPACT = new Map([
  ['ur', 'ultra'],
  ['sr', 'secret'],
  ['hr', 'hyper'],
  ['rh', 'reverse'],
]);

export function isRarityAwareQuery(parsed) {
  return Boolean(parsed?.rarityTokens?.length);
}

export function printingMatchesRarityFilter(printing, parsed) {
  if (!isRarityAwareQuery(parsed)) {
    return true;
  }
  const hay = compactQuery([
    printing?.rarity,
    printing?.number,
    printing?.card_number,
  ].filter(Boolean).join(' '));
  return (parsed.rarityTokens || []).some((token) => {
    if (token.rarity === 'secret') {
      const parts = printingCollectorParts(printing);
      return hay.includes('secret') || parts?.code === 'sl';
    }
    return hay.includes(token.rarity);
  });
}

function printingCollectorParts(printing) {
  const text = String(printing?.number || printing?.card_number || '');
  const coded = text.match(CODE_IN_NUMBER_RE);
  if (coded) {
    return {
      n: Number(coded[2]),
      suffix: '',
      d: coded[3] ? Number(coded[3]) : null,
      code: coded[1].toLowerCase(),
    };
  }
  const frac = text.match(/(\d+)([a-z])?\s*\/\s*(\d+)/i);
  if (frac) {
    return {
      n: Number(frac[1]),
      suffix: (frac[2] || '').toLowerCase(),
      d: Number(frac[3]),
      code: '',
    };
  }
  const lone = text.match(/(\d{1,3})([a-z])?/i);
  if (!lone) {
    return null;
  }
  return {
    n: Number(lone[1]),
    suffix: (lone[2] || '').toLowerCase(),
    d: null,
    code: '',
  };
}

export function isNumberAwareQuery(parsed) {
  return Boolean(parsed?.numberTokens?.length);
}

export function isBareCollectorQuery(parsed) {
  return Boolean(parsed?.numberTokens?.length && !String(parsed?.nameQuery || '').trim());
}

function collectorHaveCompact(parts) {
  if (!parts) {
    return '';
  }
  if (parts.code) {
    return `${parts.code}${parts.n}`;
  }
  return String(parts.n);
}

export function printingMatchesNumberFilter(printing, parsed) {
  if (!isNumberAwareQuery(parsed)) {
    return true;
  }
  const parts = printingCollectorParts(printing);
  if (!parts) {
    return false;
  }
  return (parsed.numberTokens || []).some((token) => {
    if (token.code) {
      if (parts.code !== token.code) {
        return false;
      }
      const have = collectorHaveCompact(parts);
      const want = `${token.code}${token.n}`;
      return have === want || have.startsWith(want);
    }
    if (parts.code) {
      return false;
    }
    if (Number(token.n) !== parts.n) {
      return false;
    }
    if (token.d != null && parts.d != null && Number(token.d) !== parts.d) {
      return false;
    }
    if (token.suffix && token.suffix !== parts.suffix) {
      return false;
    }
    return true;
  });
}

export function printingNumberRank(printing, parsed) {
  if (!isNumberAwareQuery(parsed)) {
    return 1;
  }
  if (!printingMatchesNumberFilter(printing, parsed)) {
    return 100;
  }
  const parts = printingCollectorParts(printing);
  const token = (parsed.numberTokens || []).find((row) => (
    row.code ? parts?.code === row.code : !parts?.code && Number(row.n) === parts?.n
  )) || parsed.numberTokens[0];
  if (token?.code) {
    const have = collectorHaveCompact(parts);
    const want = `${token.code}${token.n}`;
    if (have === want) {
      return 0;
    }
    return 1 + Math.abs(Number(parts.n) - Number(token.n));
  }
  return 0;
}

function groupMatchesNameQuery(group, nameQuery) {
  const want = compactQuery(nameQuery);
  if (want.length < 3) {
    return true;
  }
  const have = compactQuery(group?.name);
  return have === want || have.startsWith(want) || have.includes(want);
}

export function printingMatchesArtFilter(printing, parsed) {
  if (!isArtAwareQuery(parsed)) {
    return true;
  }
  const hay = [
    printing?.rarity,
    printing?.number,
    printing?.card_number,
    printing?.name,
    printing?.productType,
    printing?.product_type,
  ].filter(Boolean).join(' ');
  return ART_PRINTING_RE.test(hay);
}

export const NAME_POOL = RAW_NAMES.map((row) => nameRow(row.display, row.prior));

function substitutionCost(left, right) {
  if (left === right) {
    return 0;
  }
  const a = String(left || '');
  const b = String(right || '');
  if ((KEY_NEIGHBORS[a] || '').includes(b) || (KEY_NEIGHBORS[b] || '').includes(a)) {
    return KEYBOARD_COST;
  }
  return FAR_COST;
}

export function maxDistance(queryLength) {
  const len = Number(queryLength) || 0;
  if (len <= 0) {
    return 0;
  }
  if (len <= 3) {
    return KEYBOARD_COST;
  }
  if (len <= 5) {
    return FAR_COST;
  }
  return TWO_INSERT_KEYBOARD_COST;
}

export function prefixEditDistance(query, name) {
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
        prev[j - 1] + substitutionCost(qc, n[j - 1]),
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

export function mulberry32(seed) {
  let t = Number(seed) >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drop two letters (user skipped them) and swap one remaining key for a QWERTY neighbor. */
export function twoInsertKeyboardTypo(compact, random = Math.random) {
  const name = String(compact || '');
  if (name.length < 8) {
    return '';
  }
  const deleteAt = new Set();
  let guard = 0;
  while (deleteAt.size < 2 && guard < 16) {
    deleteAt.add(Math.floor(random() * name.length));
    guard += 1;
  }
  const kept = [...name].filter((_, index) => !deleteAt.has(index));
  const candidates = kept
    .map((ch, index) => ({ ch, index, neighbors: KEY_NEIGHBORS[ch] || '' }))
    .filter((row) => row.neighbors.length);
  if (deleteAt.size < 2 || !candidates.length) {
    return '';
  }
  const pick = candidates[Math.floor(random() * candidates.length)];
  kept[pick.index] = pick.neighbors[Math.floor(random() * pick.neighbors.length)];
  return kept.join('');
}

export function pikabenchCards(pool = NAME_POOL, { count = 10, seed = 2, minLength = 8 } = {}) {
  const rng = mulberry32(seed);
  const base = [...(pool || [])].filter((row) => {
    const compact = row.compact || compactQuery(row.display);
    const display = String(row.display || '');
    return compact.length >= minLength
      && compact.length <= 14
      && !/[|:()]/.test(display)
      && !MODIFIER_NAME.test(display);
  });
  for (let i = base.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = base[i];
    base[i] = base[j];
    base[j] = swap;
  }
  const picked = [];
  for (const row of base) {
    if (picked.length >= count) {
      break;
    }
    const compact = row.compact || compactQuery(row.display);
    const query = twoInsertKeyboardTypo(compact, rng);
    if (!query || query === compact) {
      continue;
    }
    const distance = prefixEditDistance(query, compact);
    if (distance > maxDistance(query.length) + 1e-9) {
      continue;
    }
    let nearest = Infinity;
    let rivalPrior = 0;
    for (const other of pool || []) {
      const otherCompact = other.compact || compactQuery(other.display);
      if (!otherCompact || otherCompact === compact) {
        continue;
      }
      const otherDistance = prefixEditDistance(query, otherCompact);
      if (otherDistance + 1e-9 < nearest) {
        nearest = otherDistance;
        rivalPrior = Math.max(1, Number(other.prior) || 1);
      } else if (Math.abs(otherDistance - nearest) <= 1e-9) {
        rivalPrior = Math.max(rivalPrior, Math.max(1, Number(other.prior) || 1));
      }
    }
    if (nearest + 1e-9 < distance) {
      continue;
    }
    if (Math.abs(nearest - distance) <= 1e-9 && rivalPrior >= Math.max(1, Number(row.prior) || 1)) {
      continue;
    }
    picked.push({
      display: row.display,
      compact,
      query,
      distance,
    });
  }
  return picked;
}

export function nowMs() {
  const clock = globalThis.performance;
  return typeof clock?.now === 'function' ? clock.now() : Date.now();
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/**
 * One 2pikabench: 10 two-insert + one-keyboard typos (seed 2). Times pool
 * ranking (`rank_ms`) and the typeahead search (`search_ms` = fetchSuggestRanked
 * wall time) when fetchSuggest is passed.
 */
export async function runTwoPikabench({
  pool = NAME_POOL,
  count = 10,
  seed = 2,
  fetchSuggest,
  fetchSearch,
  rank = rankNames,
} = {}) {
  const cards = pikabenchCards(pool, { count, seed });
  const cases = [];
  const started = nowMs();
  for (const card of cards) {
    const rankStarted = nowMs();
    const ranked = await rank(card.query, pool);
    const rankMs = nowMs() - rankStarted;
    const top = ranked?.[0];
    const ok = Boolean(top && top.compact === card.compact);
    let searchMs = null;
    let printings = 0;
    let resolvedQuery = '';
    if (typeof fetchSuggest === 'function') {
      const searchStarted = nowMs();
      const result = await fetchSuggestRanked(card.query, {
        fetchSuggest,
        fetchSearch,
        pool,
      });
      searchMs = nowMs() - searchStarted;
      printings = (result.groups || []).reduce((n, group) => n + (group.printings || []).length, 0);
      resolvedQuery = result.resolvedQuery || '';
    }
    cases.push({
      display: card.display,
      compact: card.compact,
      query: card.query,
      distance: card.distance,
      got: top?.display || '',
      ok,
      rankMs,
      searchMs,
      printings,
      resolvedQuery,
    });
  }
  const searchTimes = cases.map((row) => row.searchMs).filter((ms) => Number.isFinite(ms));
  const rankTotal = cases.reduce((n, row) => n + row.rankMs, 0);
  const searchTotal = searchTimes.reduce((n, ms) => n + ms, 0);
  return {
    name: '2pikabench',
    count: cases.length,
    recovered: cases.filter((row) => row.ok).length,
    rankMs: rankTotal,
    rankAvgMs: cases.length ? rankTotal / cases.length : 0,
    searchMs: searchTimes.length ? searchTotal : null,
    searchAvgMs: searchTimes.length ? searchTotal / searchTimes.length : null,
    totalMs: nowMs() - started,
    cases,
  };
}

export function formatTwoPikabenchReport(report) {
  const rows = (report?.cases || []).map((row, index) => {
    const search = row.searchMs == null ? '—' : `${roundMs(row.searchMs)}`;
    return `| ${index + 1} | \`${row.query}\` | ${row.display} | ${row.got || '∅'} | ${row.ok ? 'yes' : 'no'} | ${roundMs(row.rankMs)} | ${search} | ${row.printings || 0} |`;
  });
  const searchAvg = report?.searchAvgMs == null ? '—' : `${roundMs(report.searchAvgMs)} ms`;
  const searchSum = report?.searchMs == null ? '—' : `${roundMs(report.searchMs)} ms`;
  return [
    `# ${report?.name || '2pikabench'}`,
    '',
    `${report?.recovered || 0}/${report?.count || 0} recovered. rank ${roundMs(report?.rankMs)} ms total (${roundMs(report?.rankAvgMs)} ms avg). search ${searchSum} total (${searchAvg} avg). wall ${roundMs(report?.totalMs)} ms.`,
    '',
    '| # | query | want | got | ok | rank_ms | search_ms | rows |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

export function emissionMultiplier(distance) {
  return Math.exp(-DISTANCE_LAMBDA * Number(distance || 0));
}

function compareRanked(left, right) {
  return right.score - left.score
    || left.compact.length - right.compact.length
    || left.display.localeCompare(right.display);
}

const RANK_MEMO_MAX = 32;
const rankMemo = new Map();

function rankMemoKey(query, pool, fill) {
  const compact = compactQuery(query);
  const rows = pool || NAME_POOL;
  const tag = rows === NAME_POOL
    ? 'names'
    : `p${rows.length}:${rows[0]?.compact || ''}:${rows[rows.length - 1]?.compact || ''}`;
  return `${compact}|${tag}|${Math.max(1, Number(fill) || RANK_FILL)}`;
}

export function rankNames(query, pool = NAME_POOL, { fill = RANK_FILL } = {}) {
  const compact = compactQuery(query);
  if (!compact) {
    return [];
  }
  const key = rankMemoKey(query, pool, fill);
  const cached = rankMemo.get(key);
  if (cached) {
    return cached;
  }
  const { mods } = typedModifiers(query);
  const cap = maxDistance(compact.length);
  const limit = Math.max(1, Number(fill) || RANK_FILL);
  const ranked = [];
  for (const row of pool || []) {
    const compactName = row.compact || compactQuery(row.display);
    if (!compactName) {
      continue;
    }
    const distance = prefixEditDistance(compact, compactName);
    const prior = Math.max(1, Number(row.prior) || 1);
    const extra = Math.max(0, compactName.length - compact.length);
    ranked.push({
      display: row.display,
      compact: compactName,
      prior,
      distance,
      withinCap: distance <= cap + 1e-9,
      score: (popularityPoints(prior) + perfectMatchPoints(row.display, mods))
        * emissionMultiplier(distance)
        / (1 + suffixWeight(compact.length) * extra)
        * modifierPenalty(row.display, compact, mods),
      kind: row.kind || 'name',
      slug: row.slug || '',
    });
  }
  ranked.sort(compareRanked);
  const within = ranked.filter((row) => row.withinCap);
  const result = within.length ? within.slice(0, limit) : ranked.slice(0, limit);
  rankMemo.set(key, result);
  if (rankMemo.size > RANK_MEMO_MAX) {
    rankMemo.delete(rankMemo.keys().next().value);
  }
  return result;
}

/** Grow `query` one character at a time and record the top pool hit. */
export function rankPrefixTrace(query, pool = NAME_POOL, { take = 5 } = {}) {
  const raw = String(query || '');
  const steps = [];
  for (let i = 1; i <= raw.length; i += 1) {
    const prefix = raw.slice(0, i);
    if (!compactQuery(prefix)) {
      continue;
    }
    const ranked = rankNames(prefix, pool);
    steps.push({
      query: prefix,
      compact: compactQuery(prefix),
      hit: ranked[0]?.display || '',
      withinCap: Boolean(ranked[0]?.withinCap),
      top: ranked.slice(0, Math.max(1, Number(take) || 5)).map((row) => row.display),
    });
  }
  return steps;
}

export function splitPool(pool, parts) {
  const n = Math.max(1, Number(parts) || 1);
  const chunks = Array.from({ length: n }, () => []);
  for (let i = 0; i < (pool || []).length; i += 1) {
    chunks[i % n].push(pool[i]);
  }
  return chunks.filter((chunk) => chunk.length);
}

export function mergeRanked(parts, fill = RANK_FILL) {
  const ranked = (parts || []).flat();
  ranked.sort(compareRanked);
  const limit = Math.max(1, Number(fill) || RANK_FILL);
  const within = ranked.filter((row) => row.withinCap);
  if (within.length) {
    return within.slice(0, limit);
  }
  return ranked.slice(0, limit);
}

export function rankConcurrency(value) {
  if (Number.isFinite(value) && value >= 1) {
    return Math.max(1, Math.min(8, Math.floor(value)));
  }
  if (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency) > 1) {
    return Math.max(2, Math.min(8, navigator.hardwareConcurrency));
  }
  return 4;
}

export async function rankNamesParallel(query, pool = NAME_POOL, {
  concurrency,
  mapChunk,
  fill = RANK_FILL,
} = {}) {
  const compact = compactQuery(query);
  if (!compact) {
    return [];
  }
  const n = rankConcurrency(concurrency);
  if (!mapChunk || n <= 1 || (pool || []).length <= 1) {
    return rankNames(query, pool, { fill });
  }
  const chunks = splitPool(pool, n);
  const parts = await Promise.all(chunks.map((chunk, index) => Promise.resolve(mapChunk(query, chunk, index))));
  return mergeRanked(parts, fill);
}

/** Collector short codes that are not era extras as a single compact token. */
const COLLECTOR_ERA_ALIASES = {
  hgss: 'HeartGold & SoulSilver',
  hgs: 'HeartGold & SoulSilver',
  sl: 'Call of Legends',
  col: 'Call of Legends',
  legen: 'Call of Legends',
  legend: 'Call of Legends',
  legends: 'Call of Legends',
};

/** Do not treat leftover EX as Expedition / the EX block. */
const BLOCKED_SET_ALIASES = new Set(['ex']);

let aliasIndexCache = null;
let setAliasPoolCache = null;

function compactAlias(value) {
  return compactQuery(String(value || '').replace(/-/g, ' '));
}

function eraNeedles(era) {
  const names = [...(era.en || []), ...(era.jp || []), ...(era.cn || [])];
  const needles = new Set([compactAlias(era.id), ...names.map(compactAlias)]);
  for (const extra of era.extras || []) {
    const compact = compactAlias(extra);
    if (compact.length >= 2 && !BLOCKED_SET_ALIASES.has(compact)) {
      needles.add(compact);
    }
  }
  return { setNames: names, needles };
}

function buildAliasState() {
  if (aliasIndexCache && setAliasPoolCache) {
    return { map: aliasIndexCache, pool: setAliasPoolCache };
  }
  const map = new Map();
  const pool = [];
  const seenPool = new Set();
  function remember(compact, packed, display, poolable) {
    if (!compact || BLOCKED_SET_ALIASES.has(compact)) {
      return;
    }
    if (!map.has(compact)) {
      map.set(compact, packed);
    }
    if (!poolable || compact.length < 6 || seenPool.has(compact)) {
      return;
    }
    seenPool.add(compact);
    pool.push({
      ...nameRow(display, 1),
      eraId: packed.eraId,
      setNames: packed.setNames,
      needles: packed.needles,
    });
  }
  for (const era of TCG_ERA_CATALOG) {
    const packed = { eraId: era.id, ...eraNeedles(era) };
    for (const extra of era.extras || []) {
      const compact = compactAlias(extra);
      if (compact.length < 2) {
        continue;
      }
      remember(compact, packed, String(extra).replace(/-/g, ' '), compact.length >= 6);
    }
    for (const label of packed.setNames) {
      const compact = compactAlias(label);
      if (compact.length < 6) {
        continue;
      }
      remember(compact, packed, label, true);
    }
  }
  for (const [alias, eraId] of Object.entries(COLLECTOR_ERA_ALIASES)) {
    const packed = map.get(compactAlias(alias))
      || [...map.values()].find((row) => row.eraId === eraId);
    if (packed) {
      map.set(alias, packed);
    }
  }
  aliasIndexCache = map;
  setAliasPoolCache = pool;
  return { map, pool };
}

function expansionAliasIndex() {
  return buildAliasState().map;
}

export function setAliasPool() {
  return buildAliasState().pool;
}

function packedFromRankedSet(ranked) {
  if (!ranked?.compact) {
    return null;
  }
  return expansionAliasIndex().get(ranked.compact)
    || expansionAliasIndex().get(compactAlias(ranked.display))
    || null;
}

/** Token longer than 3 letters that is an unfinished expansion title (`plasma`). */
const MIN_EXPANSION_PREFIX = 4;
/** Bare set browse (`expedition`). Shorter tokens stay names (`dark`, `plasma`). */
export const MIN_BARE_SET_PREFIX = 8;
let expansionPrefixRowsCache = null;

function expansionPrefixRows() {
  if (expansionPrefixRowsCache) {
    return expansionPrefixRowsCache;
  }
  const rows = [];
  const seen = new Set();
  function add(display, slug = '') {
    const compact = compactAlias(display);
    if (!compact || compact.length < MIN_EXPANSION_PREFIX || BLOCKED_SET_ALIASES.has(compact) || seen.has(compact)) {
      return;
    }
    seen.add(compact);
    rows.push({ display, compact, slug });
  }
  for (const row of RAW_SETS) {
    add(row.display, row.slug);
  }
  for (const era of TCG_ERA_CATALOG) {
    for (const label of [...(era.en || []), ...(era.jp || []), ...(era.cn || [])]) {
      add(label);
    }
  }
  expansionPrefixRowsCache = rows;
  return rows;
}

function packedFromExpansionPrefix(compact) {
  if (!compact || compact.length < MIN_EXPANSION_PREFIX || BLOCKED_SET_ALIASES.has(compact)) {
    return null;
  }
  if (MODIFIER_WORD.has(compact) || ART_ALIAS_COMPACT.has(compact)) {
    return null;
  }
  if (namePoolHasCompact(compact)) {
    return null;
  }
  const hits = expansionPrefixRows().filter((row) => (
    row.compact === compact || row.compact.startsWith(compact)
  ));
  if (!hits.length) {
    return null;
  }
  return {
    eraId: '',
    setNames: hits.map((row) => row.display),
    needles: [...new Set([compact, ...hits.map((row) => row.compact)])],
    prefix: true,
    slug: hits.find((row) => row.slug)?.slug || '',
  };
}

function isPairJoin(word) {
  return PAIR_JOIN_RE.test(String(word || '').trim());
}

/**
 * Card suffixes that collide with set aliases: HGSS LEGEND vs Call of Legends,
 * Tag Team GX vs SM tag-team extras, `Palkia &` vs Paldea.
 * `palkia legen` (no pair, no *LEGEND name) still peels as Call of Legends.
 */
export function isCardMechanicAt(words, index) {
  const list = words || [];
  const compact = compactQuery(list[index]);
  const prev = compactQuery(list[index - 1] || '');
  const prev2 = compactQuery(`${list[index - 2] || ''} ${list[index - 1] || ''}`);
  if (prev2 === 'callof' || prev === 'shining' || prev === 'hidden') {
    return false;
  }
  if (compact === 'legends') {
    return false;
  }
  if (compact === 'legend' || compact === 'legen') {
    if (list.slice(0, index).some(isPairJoin)) {
      return true;
    }
    const head = list.slice(0, index).filter((word) => compactQuery(word) && !isPairJoin(word)).join(' ');
    return namePoolHasCompact(compactQuery(`${head} legend`));
  }
  if (compact === 'tagteam' || compact === 'tag' || compact === 'team') {
    return list.slice(0, index).some(isPairJoin);
  }
  const head = list.slice(0, index).filter((word) => compactQuery(word) && !isPairJoin(word)).join(' ');
  if (!head) {
    return compact === 'mega';
  }
  if (compact === 'break') {
    return namePoolHasCompact(compactQuery(`${head} break`));
  }
  if (compact === 'lvx' || compact === 'lv') {
    return namePoolHasCompact(compactQuery(`${head} lvx`));
  }
  if (compact === 'vunion' || compact === 'union') {
    return namePoolHasCompact(compactQuery(`${head} vunion`));
  }
  if (compact === 'delta' || compact === 'species') {
    return namePoolHasCompact(compactQuery(`${head} delta species`))
      || namePoolHasCompact(compactQuery(`${head} ${compact}`));
  }
  if (compact === 'prime') {
    return namePoolHasCompact(compactQuery(`${head} prime`));
  }
  if (compact === 'star') {
    return namePoolHasCompact(compactQuery(`${head} gold star`))
      || namePoolHasCompact(compactQuery(`${head} prism star`))
      || namePoolHasCompact(compactQuery(`${head} star`));
  }
  if (compact === 'prism') {
    return namePoolHasCompact(compactQuery(`${head} prism star`));
  }
  return false;
}

function isCardMechanicPhrase(words, start, count) {
  const slice = (words || []).slice(start, start + count);
  if (!slice.length) {
    return false;
  }
  if (isPairJoin(slice[slice.length - 1])) {
    return true;
  }
  const compact = compactQuery(slice.join(' '));
  const before = (words || []).slice(0, start);
  if (compact === 'tagteam' || compact === 'tagteamgx' || compact.startsWith('tagteam')) {
    return before.some(isPairJoin) || before.some((word) => compactQuery(word).length >= 3);
  }
  if (count === 1) {
    return isCardMechanicAt(words, start);
  }
  return false;
}

function phraseLooksLikeCardName(token, setHit) {
  const phraseCompact = compactQuery(token);
  const nameHit = rankNames(token, NAME_POOL)[0];
  if (!nameHit?.withinCap || nameHit.compact !== phraseCompact) {
    return false;
  }
  return nameHit.distance <= Number(setHit?.distance || 0);
}

function classifyQueryWord(word, index) {
  const compact = compactQuery(word);
  if (ART_ALIAS_COMPACT.has(compact)) {
    return {
      kind: 'art',
      token: word,
      compact,
      art: ART_ALIAS_COMPACT.get(compact),
    };
  }
  if (RARITY_ALIAS_COMPACT.has(compact)) {
    return {
      kind: 'rarity',
      token: word,
      compact,
      rarity: RARITY_ALIAS_COMPACT.get(compact),
    };
  }
  const exact = compact.length >= 2 && !BLOCKED_SET_ALIASES.has(compact)
    ? index.get(compact)
    : null;
  if (exact) {
    if (namePoolHasCompact(compact)) {
      return { kind: 'name', token: word };
    }
    return {
      kind: 'set',
      token: word,
      compact,
      eraId: exact.eraId,
      setNames: exact.setNames,
      needles: exact.needles,
    };
  }
  const number = parseCollectorWord(word);
  if (number) {
    return number;
  }
  const prefix = packedFromExpansionPrefix(compact);
  if (prefix) {
    return {
      kind: 'set',
      token: word,
      compact,
      eraId: prefix.eraId,
      setNames: prefix.setNames,
      needles: prefix.needles,
      prefix: true,
      slug: prefix.slug || '',
    };
  }
  if (compact.length < 5) {
    return { kind: 'name', token: word };
  }
  const setHit = rankNames(word, setAliasPool())[0];
  const setOk = Boolean(setHit?.withinCap);
  if (!setOk) {
    return { kind: 'name', token: word };
  }
  const nameHit = rankNames(word, NAME_POOL)[0];
  const nameOk = Boolean(nameHit?.withinCap);
  // Exact blueprint names never peel as a set title: `eevee` stays the Eevee
  // name pool even though SWSH `Eevee Heroes` extends it. The prefix distance
  // of `eevee` against `eeveeheroes` is a 0 tie, so `sameFamily` below must
  // not win that tie (D000033).
  if (nameOk && nameHit.compact === compact) {
    return { kind: 'name', token: word };
  }
  const sameFamily = Boolean(
    nameOk
    && (nameHit.compact.startsWith(setHit.compact) || setHit.compact.startsWith(nameHit.compact)),
  );
  if (!nameOk || sameFamily || setHit.distance + 0.25 < nameHit.distance) {
    const packed = packedFromRankedSet(setHit);
    if (packed) {
      return {
        kind: 'set',
        token: word,
        compact: setHit.compact,
        eraId: packed.eraId,
        setNames: packed.setNames,
        needles: packed.needles,
      };
    }
  }
  return { kind: 'name', token: word };
}

/** Longest 2–4 word set title (`call of legendsd`). Set-alias pool only — not NAME_POOL. */
function consumeSetPhrase(words, start) {
  const maxN = Math.min(4, words.length - start);
  for (let n = maxN; n >= 2; n -= 1) {
    const token = words.slice(start, start + n).join(' ');
    const phraseCompact = compactQuery(token);
    if (phraseCompact.length < 6) {
      continue;
    }
    const setHit = rankNames(token, setAliasPool())[0];
    if (!setHit?.withinCap || !setHit.compact) {
      continue;
    }
    const extraName = Math.max(0, setHit.compact.length - phraseCompact.length);
    const extraQuery = Math.max(0, phraseCompact.length - setHit.compact.length);
    // Incomplete typed prefix of a longer set (`call of` → Call of Legends).
    // Keep an exact prefix so `palkai call of` peels while still typing
    // legends; skip fuzzy prefixes so it does not become Cold Flare.
    if (extraName > 3 && extraQuery === 0 && setHit.distance > 1e-9) {
      continue;
    }
    const packed = packedFromRankedSet(setHit);
    if (!packed) {
      continue;
    }
    if (isCardMechanicPhrase(words, start, n) || phraseLooksLikeCardName(token, setHit)) {
      continue;
    }
    return {
      classified: {
        kind: 'set',
        token,
        compact: setHit.compact,
        eraId: packed.eraId,
        setNames: packed.setNames,
        needles: packed.needles,
      },
      words: n,
    };
  }
  return null;
}

export function parseTypedQuery(query) {
  const raw = String(query || '').trim();
  const empty = {
    raw,
    nameQuery: raw,
    setTokens: [],
    artTokens: [],
    numberTokens: [],
    rarityTokens: [],
    eras: [],
  };
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const number = parseCollectorWord(raw);
    if (number) {
      return { ...empty, nameQuery: '', numberTokens: [number] };
    }
    const compact = compactQuery(raw);
    const packed = compact.length >= MIN_BARE_SET_PREFIX
      ? packedFromExpansionPrefix(compact)
      : null;
    if (packed) {
      return {
        ...empty,
        nameQuery: '',
        setTokens: [{
          token: raw,
          compact,
          eraId: packed.eraId || '',
          setNames: packed.setNames,
          needles: packed.needles,
          prefix: true,
          slug: packed.slug || '',
        }],
      };
    }
    return empty;
  }
  if (words.length < 2) {
    return empty;
  }
  if (namePoolHasCompact(compactQuery(raw))) {
    return empty;
  }
  const peeled = [];
  const rarityTokens = [];
  for (let i = 0; i < words.length; i += 1) {
    const phrase = compactQuery(`${words[i]} ${words[i + 1] || ''}`);
    if (RARITY_PHRASE_COMPACT.has(phrase)) {
      rarityTokens.push({
        token: `${words[i]} ${words[i + 1]}`,
        compact: phrase,
        rarity: RARITY_PHRASE_COMPACT.get(phrase),
      });
      i += 1;
      continue;
    }
    peeled.push(words[i]);
  }
  const index = expansionAliasIndex();
  const classified = [];
  for (let i = 0; i < peeled.length; ) {
    const phrase = consumeSetPhrase(peeled, i);
    if (phrase) {
      classified.push(phrase.classified);
      i += phrase.words;
      continue;
    }
    if (isCardMechanicAt(peeled, i)) {
      classified.push({ kind: 'name', token: peeled[i] });
      i += 1;
      continue;
    }
    classified.push(classifyQueryWord(peeled[i], index));
    i += 1;
  }
  const setTokens = classified.filter((row) => row.kind === 'set').map((row) => ({
    token: row.token,
    compact: row.compact,
    eraId: row.eraId,
    setNames: row.setNames,
    needles: row.needles,
    prefix: Boolean(row.prefix),
    slug: row.slug || '',
  }));
  const artTokens = classified.filter((row) => row.kind === 'art').map((row) => ({
    token: row.token,
    compact: row.compact,
    art: row.art,
  }));
  const numberTokens = classified.filter((row) => row.kind === 'number').map((row) => ({
    token: row.token,
    compact: row.compact,
    n: row.n,
    d: row.d,
    suffix: row.suffix,
    code: row.code || '',
  }));
  rarityTokens.push(...classified.filter((row) => row.kind === 'rarity').map((row) => ({
    token: row.token,
    compact: row.compact,
    rarity: row.rarity,
  })));
  const nameWords = classified.filter((row) => row.kind === 'name').map((row) => row.token);
  if ((!setTokens.length && !artTokens.length && !numberTokens.length && !rarityTokens.length) || !nameWords.length) {
    return empty;
  }
  return {
    raw,
    nameQuery: nameWords.join(' '),
    setTokens,
    artTokens,
    numberTokens,
    rarityTokens,
    eras: [...new Set(setTokens.map((token) => token.eraId).filter(Boolean))],
  };
}

function hasSetTokens(parsed) {
  return Boolean(parsed?.setTokens?.length);
}

export function isSetAwareQuery(parsed) {
  return Boolean(hasSetTokens(parsed) && String(parsed?.nameQuery || '').trim());
}

export function isSetOnlyQuery(parsed) {
  return Boolean(hasSetTokens(parsed) && !String(parsed?.nameQuery || '').trim());
}

function hasPrefixSetToken(parsed) {
  return (parsed?.setTokens || []).some((token) => token.prefix);
}

function setSearchHint(setName) {
  const words = String(setName || '').split(/\s+/).filter(Boolean);
  const long = words.find((word) => compactQuery(word).length >= 6);
  return long || (words.length === 1 && compactQuery(words[0]).length >= 4 ? words[0] : '');
}

export function setAwareSearchLookups(parsed) {
  const typed = String(parsed?.nameQuery || '').trim();
  const hints = [];
  const seen = new Set();
  function addHint(value, raw = false) {
    if (hints.length >= 6) {
      return;
    }
    const hint = raw
      ? String(value || '').trim()
      : (setSearchHint(value)
        || (compactQuery(value).length >= 4 ? String(value || '').trim() : ''));
    const key = compactQuery(hint);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    hints.push(hint);
  }
  for (const token of parsed.setTokens || []) {
    if (token.prefix) {
      addHint(token.token, true);
      for (const setName of token.setNames || []) {
        addHint(setName, true);
      }
      continue;
    }
    const matched = (token.setNames || []).find((setName) => compactAlias(setName) === token.compact);
    addHint(matched || token.token);
  }
  for (const token of parsed.setTokens || []) {
    if (token.prefix) {
      continue;
    }
    for (const setName of token.setNames || []) {
      addHint(setName);
    }
  }
  if (!typed) {
    return hints;
  }
  const name = compactQuery(typed) === 'energy'
    ? typed
    : resolveSearchQuery(typed, rankNames(typed));
  if (!hints.length) {
    return [name];
  }
  return hints.map((hint) => `${name} ${hint}`);
}

export function printingMatchesSetFilter(printing, parsed) {
  if (!hasSetTokens(parsed)) {
    return true;
  }
  const hay = [printing?.set, printing?.set_name, printing?.expansion_name, printing?.slug]
    .filter(Boolean)
    .join(' ');
  const era = matchTcgEra(hay);
  if (era && parsed.eras.includes(era)) {
    return true;
  }
  const compactSet = compactQuery(hay);
  return (parsed.setTokens || []).some((token) => {
    if (token.prefix && token.compact && token.compact.length >= MIN_EXPANSION_PREFIX) {
      if (compactSet.startsWith(token.compact)) {
        return true;
      }
      return (token.setNames || []).some((name) => {
        const setCompact = compactAlias(name);
        return Boolean(setCompact) && (compactSet === setCompact || compactSet.startsWith(setCompact));
      });
    }
    for (const needle of token.needles || []) {
      if (needle.length >= 4 && compactSet.includes(needle)) {
        return true;
      }
    }
    return false;
  });
}

export function isElementalEnergyName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && compactQuery(words[words.length - 1]) === 'energy';
}

function printingFromSearchCard(card = {}) {
  const id = String(card.id || card.card_id || '');
  return {
    ...card,
    id,
    card_id: id,
    name: card.name,
    set: card.set || card.set_name,
    set_name: card.set_name || card.set,
    number: card.number || card.card_number,
    card_number: card.card_number || card.number,
    image: card.gridImageUrl || card.imageUrl || card.image || card.cdn_image_url,
    item_kind: card.itemKind || card.item_kind,
    product_type: card.productType || card.product_type,
    nationality: card.nationality,
  };
}

export function groupsFromSearchCards(cards) {
  const byName = new Map();
  for (const card of cards || []) {
    const printing = printingFromSearchCard(card);
    if (!printing.id || !printing.name) {
      continue;
    }
    let group = byName.get(printing.name);
    if (!group) {
      group = { name: printing.name, printings: [] };
      byName.set(printing.name, group);
    }
    if (group.printings.some((row) => String(row.id) === printing.id)) {
      continue;
    }
    group.printings.push(printing);
  }
  return [...byName.values()];
}

export function orderEnergyGroups(groups) {
  return [...(groups || [])].sort((left, right) => {
    const ae = isElementalEnergyName(left.name) ? 0 : 1;
    const be = isElementalEnergyName(right.name) ? 0 : 1;
    return ae - be || String(left.name || '').localeCompare(String(right.name || ''));
  });
}

function printingSetRank(printing, parsed) {
  if (!hasSetTokens(parsed)) {
    return 1;
  }
  const compact = compactQuery(printing?.set || printing?.set_name);
  for (const token of parsed.setTokens || []) {
    if (token.compact && compact === token.compact) {
      return 0;
    }
    if (COLLECTOR_ERA_ALIASES[token.compact] && printingMatchesSetFilter(printing, parsed)) {
      return 0;
    }
  }
  if (printingMatchesSetFilter(printing, parsed)) {
    return hasPrefixSetToken(parsed) ? 0 : 1;
  }
  return 2;
}

function printingArtRank(printing, parsed) {
  if (!isArtAwareQuery(parsed)) {
    return 1;
  }
  if (suggestKind(printing) !== 'Singles') {
    return 3;
  }
  return printingMatchesArtFilter(printing, parsed) ? 0 : 2;
}

export async function fetchSetAwareCards(parsed, {
  fetchSearch,
  lang,
  printLang = 'all',
  signal,
  limit = 48,
  strict,
} = {}) {
  if (typeof fetchSearch !== 'function' || !hasSetTokens(parsed)) {
    return [];
  }
  const forceStrict = strict == null
    ? compactQuery(parsed.nameQuery) === 'energy' || isSetOnlyQuery(parsed)
    : Boolean(strict);
  const lookups = setAwareSearchLookups(parsed);
  const pages = await Promise.all(lookups.map((query) => fetchSearch({
    query,
    limit,
    lang,
    printLang,
    signal,
  }).catch((error) => {
    if (error?.name === 'AbortError') {
      throw error;
    }
    return { cards: [] };
  })));
  const seen = new Set();
  const matching = [];
  const rest = [];
  for (const page of pages) {
    for (const card of page?.cards || []) {
      const printing = printingFromSearchCard(card);
      if (!printing.id || seen.has(printing.id)) {
        continue;
      }
      if (printLang && printLang !== 'all' && !printLangMatchesBucket(printLang, effectivePrintBucket(printing))) {
        continue;
      }
      if (suggestKind(printing) !== 'Singles') {
        continue;
      }
      const nameWant = compactQuery(parsed.nameQuery);
      if (nameWant && nameWant !== 'energy' && nameWant.length >= 3) {
        const have = compactQuery(printing.name);
        if (!(have === nameWant || have.startsWith(nameWant) || have.includes(nameWant))) {
          continue;
        }
      }
      const hitsSet = printingMatchesSetFilter(printing, parsed);
      if (forceStrict && !hitsSet) {
        continue;
      }
      seen.add(printing.id);
      (hitsSet ? matching : rest).push(printing);
    }
  }
  const cards = [...matching, ...rest];
  cards.sort((left, right) => {
    const leftSet = printingMatchesSetFilter(left, parsed) ? 0 : 1;
    const rightSet = printingMatchesSetFilter(right, parsed) ? 0 : 1;
    if (leftSet !== rightSet) {
      return leftSet - rightSet;
    }
    if (compactQuery(parsed.nameQuery) === 'energy') {
      const ae = isElementalEnergyName(left.name) ? 0 : 1;
      const be = isElementalEnergyName(right.name) ? 0 : 1;
      if (ae !== be) {
        return ae - be;
      }
    }
    return String(left.name || '').localeCompare(String(right.name || ''))
      || printingSetRank(left, parsed) - printingSetRank(right, parsed)
      || String(left.number || '').localeCompare(String(right.number || ''));
  });
  return cards;
}

export function extraSuggestQueries(query, ranked, limit, kind = '', { tokenVariant = false } = {}) {
  const compact = compactQuery(query);
  const cap = limit == null
    ? (compact.length <= 1 ? 4 : SUGGEST_NAME_LOOKUPS)
    : Math.max(0, Number(limit) || 0);
  const tab = String(kind || '').trim().toLowerCase();
  const top = ranked?.[0];
  const topIsPrefix = Boolean(top?.compact?.startsWith(compact));
  const floor = tokenVariant ? 0 : (topIsPrefix ? Number(top.score || 0) * 0.35 : 0);
  const mods = typedModifiers(query).mods;
  const extras = [];
  const seen = new Set([compact]);
  for (const row of ranked || []) {
    if (extras.length >= cap) {
      break;
    }
    if (!row?.display || !row.compact) {
      continue;
    }
    if (row.withinCap === false) {
      continue;
    }
    // One Meili q=eevee already matches every eevee* name, so the plain
    // typeahead never needs per-variant lookups. Token-peeled queries do: the
    // 20 q=eevee rows are the plain blueprint's printings, and the labeled
    // rows live in the variant groups (Eevee ex, Eevee V, Eevee VMAX).
    if (row.compact.startsWith(compact) && !tokenVariant) {
      continue;
    }
    if (hasRivalMechanic(row.display, mods)) {
      continue;
    }
    if (seen.has(row.compact)) {
      continue;
    }
    if (Number(row.score || 0) < floor) {
      continue;
    }
    if (tab === 'singles' && suggestKind({ name: row.display }) !== 'Singles') {
      continue;
    }
    if (tab === 'product' && suggestKind({ name: row.display }) === 'Singles') {
      continue;
    }
    seen.add(row.compact);
    extras.push(row.display);
  }
  return extras;
}

/** Top pool names for extra Meili hydrates, including out-of-cap typos (`Sh1` → Shinx). */
export function rankedSuggestLookups(ranked, limit = SUGGEST_NAME_LOOKUPS, kind = '') {
  const cap = Math.max(0, Number(limit) || 0);
  const tab = String(kind || '').trim().toLowerCase();
  const extras = [];
  const seen = new Set();
  for (const row of ranked || []) {
    if (extras.length >= cap) {
      break;
    }
    if (!row?.display || !row.compact || seen.has(row.compact)) {
      continue;
    }
    if (tab === 'singles' && suggestKind({ name: row.display }) !== 'Singles') {
      continue;
    }
    if (tab === 'product' && suggestKind({ name: row.display }) === 'Singles') {
      continue;
    }
    seen.add(row.compact);
    extras.push(row.display);
  }
  return extras;
}

export function printingPrintRank(printing, printLang) {
  if (!printLang || printLang === 'all') {
    return 1;
  }
  return printLangMatchesBucket(printLang, effectivePrintBucket(printing)) ? 0 : 2;
}

export function typedMeiliQuery(typed) {
  const raw = String(typed || '').trim();
  const parsed = parseTypedQuery(raw);
  if (isSetAwareQuery(parsed) || isSetOnlyQuery(parsed)) {
    return raw;
  }
  const name = String(parsed.nameQuery || raw).trim();
  return resolveSearchQuery(name, rankNames(name));
}

export function resolveSearchQuery(query, ranked) {
  const typed = String(query || '').trim();
  const parsed = parseTypedQuery(typed);
  if (isSetAwareQuery(parsed) || isNumberAwareQuery(parsed)) {
    return typed;
  }
  const compact = compactQuery(typed);
  if (!compact) {
    return typed;
  }
  const top = ranked?.[0];
  if (!top?.display) {
    return typed;
  }
  if (top.withinCap === false) {
    return typed;
  }
  if (top.compact.startsWith(compact)) {
    return typed;
  }
  return top.display;
}

export function absorbNames(pool, groups, fallbackPrior = 8) {
  const byCompact = new Map();
  for (const row of pool || []) {
    const next = nameRow(row.display, row.prior);
    if (next.compact) {
      byCompact.set(next.compact, next);
    }
  }
  for (const group of groups || []) {
    const display = String(group?.name || '').trim();
    const compact = compactQuery(display);
    if (!compact || byCompact.has(compact)) {
      continue;
    }
    byCompact.set(compact, nameRow(display, fallbackPrior));
  }
  return [...byCompact.values()];
}

export function mergeSuggestGroups(groupLists) {
  const byName = new Map();
  const seenId = new Set();
  for (const groups of groupLists || []) {
    for (const group of groups || []) {
      const name = String(group?.name || '');
      let target = byName.get(name);
      if (!target) {
        target = { ...group, printings: [] };
        byName.set(name, target);
      }
      for (const row of group.printings || []) {
        const id = String(row?.id || row?.card_id || '');
        if (!id || seenId.has(id)) {
          continue;
        }
        seenId.add(id);
        target.printings.push(row);
      }
    }
  }
  return [...byName.values()].filter((group) => group.printings.length);
}

function groupHasCollectorHit(group, parsed) {
  return Boolean(parsed) && isNumberAwareQuery(parsed)
    && (group?.printings || []).some((printing) => printingMatchesNumberFilter(printing, parsed));
}

export function orderSuggestGroups(groups, ranked, parsed = null) {
  const score = new Map((ranked || []).map((row) => [row.compact, row.score]));
  return [...(groups || [])].sort((left, right) => {
    const lh = groupHasCollectorHit(left, parsed) ? 0 : 1;
    const rh = groupHasCollectorHit(right, parsed) ? 0 : 1;
    if (lh !== rh) {
      return lh - rh;
    }
    const sa = score.get(compactQuery(left.name)) || 0;
    const sb = score.get(compactQuery(right.name)) || 0;
    return sb - sa || String(left.name || '').localeCompare(String(right.name || ''));
  });
}

export function capSuggestGroups(groups, limit = SUGGEST_RESULT_FLOOR, perGroup = 4) {
  const cap = Math.max(0, Number(limit) || 0);
  const each = Math.max(1, Number(perGroup) || 1);
  const out = [];
  let n = 0;
  for (const group of groups || []) {
    if (n >= cap) {
      break;
    }
    const printings = (group.printings || []).slice(0, Math.min(each, cap - n));
    if (!printings.length) {
      continue;
    }
    out.push({ ...group, printings });
    n += printings.length;
  }
  return out;
}

function printingId(row) {
  return String(row?.id || row?.card_id || '');
}

function isStubPrinting(row = {}) {
  return row.live === true || printingId(row).startsWith('live:');
}

export function fillSuggestGroups(groups, limit = SUGGEST_RESULT_FLOOR, preferPerGroup = 4, parsed = null, kind = '') {
  const cap = Math.max(0, Number(limit) || 0);
  const prefer = Math.max(1, Number(preferPerGroup) || 1);
  const used = new Set();
  const added = [];
  let n = 0;
  const tab = String(kind || parsed?.searchKind || '').trim().toLowerCase();
  const mods = typedModifiers(parsed?.raw || parsed?.nameQuery || '').mods;

  function addPrinting(group, printing, relaxed = false) {
    if (n >= cap) {
      return false;
    }
    if (tab === 'users') {
      return false;
    }
    if (tab === 'singles' && suggestKind(printing, group?.name) !== 'Singles') {
      return false;
    }
    if (tab === 'product' && suggestKind(printing, group?.name) === 'Singles') {
      return false;
    }
    if (parsed && isArtAwareQuery(parsed) && suggestKind(printing, group?.name) !== 'Singles') {
      return false;
    }
    if (isStubPrinting(printing)) {
      return false;
    }
    if (mods.length && hasRivalMechanic(group?.name || printing?.name, mods)) {
      return false;
    }
    const strictSet = Boolean(
      parsed
      && (
        isSetOnlyQuery(parsed)
        || (isSetAwareQuery(parsed) && compactQuery(parsed.nameQuery) === 'energy')
      )
    );
    if (strictSet && !printingMatchesSetFilter(printing, parsed)) {
      return false;
    }
    if (
      parsed
      && isNumberAwareQuery(parsed)
      && !isBareCollectorQuery(parsed)
      && !relaxed
      && !printingMatchesNumberFilter(printing, parsed)
    ) {
      return false;
    }
    const id = printingId(printing);
    if (!id || used.has(id)) {
      return false;
    }
    used.add(id);
    n += 1;
    added.push({ group, printing });
    return true;
  }

  const list = groups || [];
  if (parsed && isArtAwareQuery(parsed)) {
    for (const group of list) {
      for (const printing of group.printings || []) {
        if (printingArtRank(printing, parsed) === 0) {
          addPrinting(group, printing);
        }
      }
    }
  }
  if (parsed && isRarityAwareQuery(parsed)) {
    for (const group of list) {
      for (const printing of group.printings || []) {
        if (printingMatchesRarityFilter(printing, parsed)) {
          addPrinting(group, printing);
        }
      }
    }
  }
  if (parsed && isNumberAwareQuery(parsed)) {
    for (const group of list) {
      for (const printing of group.printings || []) {
        if (printingMatchesNumberFilter(printing, parsed)) {
          addPrinting(group, printing);
        }
      }
    }
  }
  if (parsed && hasSetTokens(parsed)) {
    for (const group of list) {
      for (const printing of group.printings || []) {
        if (printingSetRank(printing, parsed) === 0) {
          addPrinting(group, printing);
        }
      }
    }
  }
  for (const group of list) {
    let taken = 0;
    for (const printing of group.printings || []) {
      if (taken >= prefer || n >= cap) {
        break;
      }
      if (addPrinting(group, printing)) {
        taken += 1;
      }
    }
  }
  if (n < cap) {
    // Relaxed top-up: the strict number pass above may have filled nothing
    // (the only matching printing sits outside the cached rows, or the print
    // filter hid it). The popup must still show the ranked name's cards —
    // matched rows are already in, closest misses follow — never "No singles
    // match" while the group has printings.
    for (const group of list) {
      for (const printing of group.printings || []) {
        if (n >= cap) {
          break;
        }
        addPrinting(group, printing, true);
      }
    }
  }
  // Token-carrying queries score every member with the same comparator the
  // desk sort uses (rarity token > art > number > set, then the group's pool
  // rank); tokenless queries keep the per-group interleave from the passes
  // above. The rebuild merges only ADJACENT same-name blocks — a global
  // name-merge would bury a later group's token rows under an earlier
  // name's plain fill.
  const scored = Boolean(parsed && (
    isArtAwareQuery(parsed)
    || isRarityAwareQuery(parsed)
    || isSetAwareQuery(parsed)
    || isSetOnlyQuery(parsed)
    || isNumberAwareQuery(parsed)
  ));
  if (scored) {
    const groupIndex = new Map(list.map((group, index) => [String(group?.name || ''), index]));
    const rarityMiss = (row) => (
      isRarityAwareQuery(parsed) && !printingMatchesRarityFilter(row.printing, parsed) ? 1 : 0
    );
    added.sort((left, right) => (
      rarityMiss(left) - rarityMiss(right)
      || printingArtRank(left.printing, parsed) - printingArtRank(right.printing, parsed)
      || printingNumberRank(left.printing, parsed) - printingNumberRank(right.printing, parsed)
      || printingSetRank(left.printing, parsed) - printingSetRank(right.printing, parsed)
      || (groupIndex.get(String(left.group?.name || '')) || 0)
        - (groupIndex.get(String(right.group?.name || '')) || 0)
      || String(left.printing?.number || left.printing?.card_number || '').localeCompare(
        String(right.printing?.number || right.printing?.card_number || ''),
      )
    ));
  }
  const rebuilt = [];
  for (const row of added) {
    const last = rebuilt[rebuilt.length - 1];
    if (last && last.name === row.group?.name) {
      last.printings.push(row.printing);
      continue;
    }
    rebuilt.push({ ...row.group, printings: [row.printing] });
  }
  return rebuilt;
}

function uniqueSuggestLookups(values) {
  const unique = [];
  const seen = new Set();
  for (const lookup of values || []) {
    const key = compactQuery(lookup) || String(lookup || '').trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(lookup);
  }
  return unique;
}

function resolvedNameQuery(nameQuery, ranked) {
  if (compactQuery(nameQuery) === 'energy') {
    return nameQuery;
  }
  return resolveSearchQuery(nameQuery, ranked);
}

export async function fetchSuggestRanked(term, {
  fetchSuggest,
  fetchSearch,
  limit = SUGGEST_RESULT_FLOOR,
  signal,
  lang,
  printLang,
  pool = NAME_POOL,
  extraLimit,
  concurrency,
  mapChunk,
  kind = '',
  resolved = null,
} = {}) {
  const query = String(term || '').trim();
  const parsed = parseTypedQuery(query);
  const bareNumber = isBareCollectorQuery(parsed);
  const setOnly = isSetOnlyQuery(parsed);
  const nameQuery = bareNumber || setOnly ? '' : (parsed.nameQuery || query);
  const rankQuery = bareNumber || setOnly ? query : nameQuery;
  // Resolver parity: when the hypothesis step corrected the query (artist /
  // set binding or typo tokens), the corrected text is the PRIMARY lookup and
  // the raw typed query stays as the challenger. The popup count comes from
  // the corrected lookup — never max-over-junk-lookups.
  const corrected = resolved?.correctedQuery
  && (resolved.hasArtist || resolved.hasSet || (resolved.best?.free?.length || 0) > 0)
    ? String(resolved.correctedQuery).trim()
    : '';
  const primaryName = corrected || nameQuery;
  const peeled = isSetAwareQuery(parsed)
    || setOnly
    || isArtAwareQuery(parsed)
    || isNumberAwareQuery(parsed)
    || isRarityAwareQuery(parsed);
  const setAware = (isSetAwareQuery(parsed) || setOnly) && typeof fetchSearch === 'function';
  // Ordinary multi-token free text uses the HIGH-RECALL full-text SEARCH
  // endpoint for candidate generation — the same endpoint set-aware queries
  // already use — so the retrieval engine no longer depends on whether the
  // legacy parser recognized a set. This is what lets `Pikachu & Zekrom GX`
  // reach the candidate union for `pikachu gx`, exactly as `Palkia & Dialga
  // LEGEND` already did for `palkia legend`. Structured paths (bare collector,
  // set-only, art/rarity/number peels, set-aware) keep their own retrieval.
  // Scorer-owned free text (matches liveSuggestGroups' isFreeText): everything
  // except a bare collector number, a set-only browse, or the `energy` browse.
  // Set/rarity/art/mechanic recognition is EVIDENCE, not a retrieval switch —
  // so `palkia legend`, `charizard sr`, `arceus platinum` all use generic
  // high-recall search too, not the legacy set-filtered rescue.
  const isEnergyQuery = isSetAwareQuery(parsed) && compactQuery(nameQuery) === 'energy';
  const queryWordCount = String(query).trim().split(/\s+/).filter(Boolean).length;
  const freeTextSearch = !bareNumber && !setOnly && !isEnergyQuery
    && queryWordCount >= 2 && typeof fetchSearch === 'function';
  const suggestFn = typeof fetchSuggest === 'function'
    ? fetchSuggest
    : async () => ({ groups: [], count: 0 });
  function suggestLookup(lookup) {
    return suggestFn(lookup, {
      limit,
      signal,
      lang,
      printLang,
      // Corrected primary lookups run strict server-side (match=all) so a
      // resolver anchor cannot silently vanish; challengers stay relaxed.
      match: corrected && compactQuery(lookup) === compactQuery(corrected) ? 'all' : undefined,
    }).catch((error) => {
      if (error?.name === 'AbortError') {
        throw error;
      }
      return { groups: [], count: 0 };
    });
  }
  if (setOnly) {
    if (typeof fetchSearch !== 'function') {
      return {
        groups: [],
        count: 0,
        ranked: [],
        resolvedQuery: query,
        cards: [],
        hydrated: [],
      };
    }
    const cards = await fetchSetAwareCards(parsed, {
      fetchSearch,
      lang,
      printLang,
      signal,
      limit: Math.max(48, limit),
      strict: true,
    });
    const grouped = groupsFromSearchCards(cards);
    for (const group of grouped) {
      group.printings.sort((left, right) => (
        printingSetRank(left, parsed) - printingSetRank(right, parsed)
        || String(left.number || '').localeCompare(String(right.number || ''))
      ));
    }
    const groups = fillSuggestGroups(grouped, limit, 1, parsed, kind);
    const filled = groups.reduce((n, group) => n + (group.printings || []).length, 0);
    return {
      groups,
      count: Math.max(cards.length, filled),
      ranked: [],
      resolvedQuery: query,
      cards,
      hydrated: grouped,
    };
  }
  const rankedPromise = rankNamesParallel(rankQuery, pool, { concurrency, mapChunk });
  const energyQuery = compactQuery(nameQuery) === 'energy';
  if (setAware && energyQuery) {
    const ranked = await rankedPromise;
    const resolvedName = resolvedNameQuery(nameQuery, ranked);
    const resolvedParsed = { ...parsed, nameQuery: resolvedName };
    const cards = await fetchSetAwareCards(resolvedParsed, {
      fetchSearch,
      lang,
      printLang,
      signal,
      strict: true,
    });
    const grouped = groupsFromSearchCards(cards);
    for (const group of grouped) {
      group.printings.sort((left, right) => (
        printingSetRank(left, parsed) - printingSetRank(right, parsed)
        || String(left.number || '').localeCompare(String(right.number || ''))
      ));
    }
    const energyGroups = orderEnergyGroups(grouped);
    return {
      groups: fillSuggestGroups(energyGroups, limit, 2, parsed, kind),
      count: cards.length,
      ranked,
      resolvedQuery: query,
      cards,
      hydrated: energyGroups,
    };
  }

  const immediateLookups = uniqueSuggestLookups(bareNumber
    ? [
      query,
      ...parsed.numberTokens.map((token) => token.token),
    ]
    : [
      primaryName,
      peeled ? '' : query,
    ]);
  const immediatePayloadsPromise = Promise.all(immediateLookups.map(suggestLookup));
  const ranked = await rankedPromise;
  const resolvedName = bareNumber ? query : (corrected || resolvedNameQuery(nameQuery, ranked));
  const resolvedParsed = { ...parsed, nameQuery: resolvedName };
  const firstWord = String(query).trim().split(/\s+/)[0] || '';
  // Free text draws its candidates from the SEARCH endpoint, not from a
  // first-word rankNames fan-out — that seed ranked `pikachu` variants and
  // buried the `Pikachu & Zekrom GX` Tag Team. Only non-free-text keeps it.
  const seedLookups = !bareNumber
    && !peeled
    && !freeTextSearch
    && compactQuery(firstWord).length >= 3
    && compactQuery(firstWord) !== compactQuery(nameQuery)
    ? extraSuggestQueries(query, rankNames(firstWord, pool), extraLimit, kind)
    : [];
  const extraLookups = uniqueSuggestLookups(bareNumber
    ? rankedSuggestLookups(ranked, extraLimit ?? SUGGEST_NAME_LOOKUPS, kind)
    : [
      resolvedName,
      ...extraSuggestQueries(nameQuery, ranked, extraLimit, kind, {
        tokenVariant: isArtAwareQuery(parsed) || isRarityAwareQuery(parsed),
      }),
      ...seedLookups,
    ]).filter((lookup) => (
      !immediateLookups.some((row) => compactQuery(row) === compactQuery(lookup))
    ));
  let searchPagePayload = null;
  const [setCards, immediatePayloads, extraPayloads] = await Promise.all([
    freeTextSearch
      // High-recall full-text search for the raw query — the candidate source
      // that actually contains the compound cards (Tag Teams, LEGEND pairs).
      // Takes precedence over the set-filtered path so recognition of a set
      // token no longer decides the retrieval engine.
      ? fetchSearch({ query, offset: 0, limit: Math.max(48, limit), lang, printLang, signal })
        .then((data) => {
          searchPagePayload = data;
          return data?.cards || [];
        })
        .catch((error) => { if (error?.name === 'AbortError') { throw error; } return []; })
      : (setAware
        ? fetchSetAwareCards(resolvedParsed, { fetchSearch, lang, signal, strict: false })
        : Promise.resolve([])),
    immediatePayloadsPromise,
    Promise.all(extraLookups.map(suggestLookup)),
  ]);
  // Anchor fallback: strict primary came back empty and the corrected text
  // carried unresolved free text — relax ONLY the free text, keeping the
  // required name anchors mandatory (never the raw challenger's relaxation).
  let payloads = [...immediatePayloads, ...extraPayloads];
  let suggestLookups = [...immediateLookups, ...extraLookups];
  const anchorQuery = corrected && resolved?.best?.entities.name?.length
    ? resolved.best.entities.name.map((row) => row.display).join(' ').trim()
    : '';
  if (
    corrected
    && anchorQuery
    && compactQuery(anchorQuery) !== compactQuery(corrected)
    && !(payloads[0]?.groups || []).length
    && !suggestLookups.some((lookup) => compactQuery(lookup) === compactQuery(anchorQuery))
  ) {
    const anchorPayload = await suggestFn(anchorQuery, {
      limit,
      signal,
      lang,
      printLang,
      match: 'all',
    }).catch(() => null);
    if (anchorPayload) {
      payloads = [anchorPayload, ...payloads];
      suggestLookups = [anchorQuery, ...suggestLookups];
    }
  }

  let merged = mergeSuggestGroups([
    groupsFromSearchCards(setCards),
    ...payloads.map((payload) => payload?.groups || []),
  ]);
  if (!bareNumber && compactQuery(resolvedName).length >= 3) {
    // Name-lock keeps set/number-aware queries focused on the typed name. It is
    // safe with high-recall search: a compound like `Palkia & Dialga LEGEND`
    // contains the name (`palkia`) so it survives, while unrelated set-mates
    // (Flareon in the same Plasma set) are dropped. `pikachu gx` is not
    // set/number-aware, so it is never locked and the Tag Team stays.
    const nameLock = isNumberAwareQuery(parsed)
      || (isSetAwareQuery(parsed) && compactQuery(nameQuery) !== 'energy');
    if (nameLock) {
      const named = merged.filter((group) => (
        groupMatchesNameQuery(group, resolvedName)
        || groupMatchesNameQuery(group, nameQuery)
      ));
      if (named.length) {
        merged = named;
      }
    }
  }
  for (const group of merged) {
    group.printings.sort((left, right) => (
      printingArtRank(left, parsed) - printingArtRank(right, parsed)
      || printingNumberRank(left, parsed) - printingNumberRank(right, parsed)
      || printingPrintRank(left, printLang) - printingPrintRank(right, printLang)
      || printingSetRank(left, parsed) - printingSetRank(right, parsed)
      || String(left.number || '').localeCompare(String(right.number || ''))
    ));
  }
  const livePool = absorbNames(pool, merged);
  const reranked = await rankNamesParallel(rankQuery, livePool, { concurrency, mapChunk });
  const ordered = orderSuggestGroups(merged, reranked, parsed);
  const typoName = Boolean(
    !bareNumber
    && ranked[0]
    && !ranked[0].compact.startsWith(compactQuery(nameQuery)),
  );
  const perGroup = setAware || typoName || isArtAwareQuery(parsed)
    || isRarityAwareQuery(parsed)
    || (isNumberAwareQuery(parsed) && !bareNumber)
    || typedModifiers(query).mods.length
    ? limit
    : 4;
  const groups = fillSuggestGroups(ordered, limit, perGroup, parsed, kind);
  const resolvedQuery = setAware || bareNumber
    ? query
    : (isNumberAwareQuery(parsed)
      ? resolvedName
      : resolveSearchQuery(query, reranked));
  const countByLookup = new Map(suggestLookups.map((lookup, index) => [
    compactQuery(lookup) || lookup,
    Number(payloads[index]?.count) || 0,
  ]));
  const filled = groups.reduce((n, group) => n + (group.printings || []).length, 0);
  // Count ownership: the free-text count is the SEARCH endpoint's total for
  // the raw query — the same predicate as the "View all" destination. The
  // suggest lookups' estimatedTotalHits are relaxed, token-dropping Meili
  // estimates (default "last" strategy) and must never inflate the number:
  // "pikachu gx 30th" is not "pikachu" (≈ the whole Pikachu pool).
  const searchTotal = Number(searchPagePayload?.total);
  const lookupMax = Math.max(
    setCards.length,
    countByLookup.get(compactQuery(resolvedName)) || 0,
    countByLookup.get(compactQuery(resolvedQuery)) || 0,
    Number(payloads[0]?.count) || 0,
    filled,
  );
  const count = bareNumber
    ? Math.max(countByLookup.get(compactQuery(query)) || 0, filled)
    : Number.isFinite(searchTotal)
      ? Math.max(searchTotal, filled)
      : lookupMax;
  return {
    groups,
    count,
    ranked: reranked,
    resolvedQuery,
    cards: setCards,
    hydrated: ordered,
  };
}
