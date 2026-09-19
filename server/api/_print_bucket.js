'use strict';

/**
 * Canonical print-universe classification for search / suggest / flags.
 * Mirror of pokoin-web market/src/print-bucket.js — keep behavior identical.
 * docs/PRINT_FLAGS.md
 */

const PRINT_BUCKETS = Object.freeze([
  'western',
  'japanese',
  'korean',
  'chinese',
  'indonesian',
  'thai',
  'idth',
  'unknown',
]);

const SEARCH_PRINT_BUCKETS = Object.freeze([
  'western',
  'japanese',
  'korean',
  'chinese',
]);

function printBucket(nationality) {
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

function effectivePrintBucket(row = {}, expansionNationalityLookup) {
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
  const stamped = printBucket(row?.expansion_nationality || row?.expansionNationality);
  if (stamped !== 'unknown') {
    return stamped;
  }
  return 'unknown';
}

// Search menu folds Korean print into Japanese (jpko) — match both buckets.
function printLangMatchesBucket(want, bucket) {
  const have = String(bucket || '').trim().toLowerCase();
  const selected = String(want || '').trim().toLowerCase();
  if (selected === 'japanese') {
    return have === 'japanese' || have === 'korean';
  }
  return have === selected;
}

function printingMatchesPrintLang(row, printLang, expansionNationalityLookup) {
  const want = String(printLang || 'all').trim().toLowerCase();
  if (!want || want === 'all') {
    return true;
  }
  if (row?.live === true || String(row?.id || row?.card_id || '').startsWith('live:')) {
    return true;
  }
  return printLangMatchesBucket(want, effectivePrintBucket(row, expansionNationalityLookup));
}

function mergePrintingFields(existing = {}, incoming = {}) {
  const out = { ...existing, ...incoming };
  const knownNat = String(existing?.nationality || '').trim();
  const nextNat = String(incoming?.nationality || '').trim();
  if (knownNat && !nextNat) {
    out.nationality = knownNat;
  }
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

function cleanPrintLanguage(value) {
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
  // Korean rides the merged japanese (jpko) menu option.
  if (raw === 'ko' || raw === 'korean') {
    return 'japanese';
  }
  if (raw === 'zh' || raw === 'cn' || raw === 'zht') {
    return 'chinese';
  }
  const bucket = printBucket(raw);
  if (bucket === 'korean') {
    return 'japanese';
  }
  if (SEARCH_PRINT_BUCKETS.includes(bucket)) {
    return bucket;
  }
  return 'all';
}

module.exports = {
  printLangMatchesBucket,
  PRINT_BUCKETS,
  SEARCH_PRINT_BUCKETS,
  printBucket,
  effectivePrintBucket,
  printingMatchesPrintLang,
  mergePrintingFields,
  cleanPrintLanguage,
};
