/**
 * Unicode-safe compaction shared across search / suggest / cache keys.
 * Kept in its own module so framework-free code (locale, api, print filters)
 * can compact a string without importing the typeahead ranker and its
 * 10k-name catalog. suggest-rank.js re-exports it.
 */

/** compactQuery runs for every pool row on every keystroke (absorbNames → nameRow): memoise it. */
const COMPACT_MEMO = new Map();
const COMPACT_MEMO_MAX = 20000;

/** ASCII input needs no normalisation: NFKC/NFD/NFC are the identity and [^\p{L}\p{N}] is [^a-z0-9]. */
const ASCII_ONLY = /^[\x00-\x7f]*$/;

export function compactQuery(value) {
  const text = String(value || "");
  const hit = COMPACT_MEMO.get(text);
  if (hit !== undefined) {
    return hit;
  }
  // Order matters: NFKC folds full-width/compatibility and composes; strip
  // Greek delta (delta-species shorthand); NFD exposes Latin diacritics as
  // trailing combining marks; strip ONLY U+0300-U+036F so `é`->`e` while
  // Japanese dakuten/handakuten (U+3099/U+309A, outside that range) survive;
  // NFC recomposes voiced kana; then casefold and drop non-letter/number.
  // Invariant: NFC and NFD forms of the same string collapse to one compact,
  // but distinct kana stay distinct (compactQuery("ピ") !== compactQuery("ヒ")).
  const compact = ASCII_ONLY.test(text)
    ? text.toLowerCase().replace(/[^a-z0-9]+/g, "")
    : text
      .normalize("NFKC")
      .replace(/[δΔ]/g, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  if (COMPACT_MEMO.size >= COMPACT_MEMO_MAX) {
    COMPACT_MEMO.clear();
  }
  COMPACT_MEMO.set(text, compact);
  return compact;
}
