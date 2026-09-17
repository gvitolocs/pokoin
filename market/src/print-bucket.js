/**
 * Canonical print-universe classification for search / suggest / flags.
 *
 * Priority:
 *   1. explicit card/printing nationality
 *   2. reliable expansion nationality metadata
 *   3. unknown
 *
 * Empty is NOT western. Mirror: cardvault api/_print_bucket.js
 * docs/PRINT_FLAGS.md
 */

export const PRINT_BUCKETS = Object.freeze([
  'western',
  'japanese',
  'korean',
  'chinese',
  'indonesian',
  'thai',
  'idth',
  'unknown',
]);

/** Search print chips that constrain the candidate universe. */
export const SEARCH_PRINT_BUCKETS = Object.freeze([
  'western',
  'japanese',
  'korean',
  'chinese',
]);

/**
 * Normalize a raw nationality string into a print bucket.
 * Empty / product / unrecognized → `unknown` (never silently western).
 */
export function printBucket(nationality) {
  const value = String(nationality || '').trim().toLowerCase();
  if (!value || value === 'product' || value === 'unknown') {
    return 'unknown';
  }
  if (value === 'japanese' || value === 'ja' || value === 'jp') {
    return 'japanese';
  }
  if (value === 'korean' || value === 'ko') {
    return 'korean';
  }
  if (value === 'chinese' || value === 'zh' || value === 'cn' || value === 'zht') {
    return 'chinese';
  }
  if (value === 'indonesian' || value === 'id') {
    return 'indonesian';
  }
  if (value === 'thai' || value === 'th') {
    return 'thai';
  }
  if (value === 'idth') {
    return 'idth';
  }
  if (
    value === 'western'
    || value === 'european'
    || value === 'eu'
    || value === 'american'
    || value === 'us'
    || value === 'french'
    || value === 'fr'
    || value === 'german'
    || value === 'de'
  ) {
    return 'western';
  }
  return 'unknown';
}

/**
 * Effective print bucket for a printing/card row.
 * @param {{ nationality?: string, set?: string, set_name?: string }} row
 * @param {(setName: string) => string} [expansionNationalityLookup]
 */
export function effectivePrintBucket(row = {}, expansionNationalityLookup) {
  const explicit = printBucket(row?.nationality);
  if (explicit !== 'unknown') {
    return explicit;
  }
  const setName = row?.set || row?.set_name || row?.expansion_name || '';
  if (typeof expansionNationalityLookup === 'function' && setName) {
    const fromExpansion = printBucket(expansionNationalityLookup(setName));
    if (fromExpansion !== 'unknown') {
      return fromExpansion;
    }
  }
  // Prefer a stamped expansion nationality on the row itself.
  const stamped = printBucket(row?.expansion_nationality || row?.expansionNationality);
  if (stamped !== 'unknown') {
    return stamped;
  }
  return 'unknown';
}

export function printingMatchesPrintLang(row, printLang, expansionNationalityLookup) {
  const want = String(printLang || 'all').trim().toLowerCase();
  if (!want || want === 'all') {
    return true;
  }
  if (row?.live === true || String(row?.id || row?.card_id || '').startsWith('live:')) {
    return true;
  }
  return effectivePrintBucket(row, expansionNationalityLookup) === want;
}

/**
 * Prefer known nationality over empty when merging cache/hydration rows.
 * Stronger non-empty fields win; empty incoming never erases known values.
 */
export function mergePrintingFields(existing = {}, incoming = {}) {
  const out = { ...existing, ...incoming };
  const knownNat = String(existing?.nationality || '').trim();
  const nextNat = String(incoming?.nationality || '').trim();
  if (knownNat && !nextNat) {
    out.nationality = knownNat;
  }
  // Preserve other identity fields the same way when incoming is blank.
  for (const key of [
    'set',
    'set_name',
    'number',
    'card_number',
    'collector_number',
    'image',
    'cdn_image_url',
    'image_url',
    'item_kind',
    'itemKind',
    'product_type',
    'productType',
    'rarity',
    'name',
  ]) {
    const prev = existing?.[key];
    const next = incoming?.[key];
    const prevText = prev == null ? '' : String(prev).trim();
    const nextText = next == null ? '' : String(next).trim();
    if (prevText && !nextText) {
      out[key] = prev;
    }
  }
  return out;
}

export function cleanPrintLanguage(value) {
  const raw = String(value || 'all').trim().toLowerCase();
  if (raw === 'all') {
    return 'all';
  }
  if (raw === 'eu') {
    return 'western';
  }
  if (raw === 'jp' || raw === 'ja') {
    return 'japanese';
  }
  if (raw === 'ko') {
    return 'korean';
  }
  if (raw === 'zh' || raw === 'cn' || raw === 'zht') {
    return 'chinese';
  }
  const bucket = printBucket(raw);
  if (SEARCH_PRINT_BUCKETS.includes(bucket)) {
    return bucket;
  }
  return 'all';
}
