/**
 * Scan queue: CLIP same-artwork versions + listing-language print preference.
 * Source: GET /api/marketplace-version-set (pokoin_version_sets).
 *
 * Batch Defaults / row language drives the default printing:
 * western langs → western, JP/KO/ID/TH/VI → japanese|korean, ZH/ZHT → chinese.
 *
 * Scan Desk LANG select lists every language; picking an Asian code remaps the
 * expansion when a sibling exists. Card desk still restricts langs by nationality.
 */

import { printLangBadge } from './card-versions.js';

function printingId(row) {
  return String(row?.id || row?.card_id || row?.cardId || '').trim();
}

function nationalityOf(row) {
  return String(row?.nationality || '').trim().toLowerCase();
}

/** Same codes as locale.ASIAN_CARD_LANGS — kept local so this module stays react-free for node:test. */
const ASIAN = new Set(['JP', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI']);

/** @returns {'western'|'jpko'|'chinese'} */
export function preferredPrintBucket(listingLanguage = '') {
  const lang = String(listingLanguage || '').trim().toUpperCase();
  if (lang === 'ZH' || lang === 'ZHT') return 'chinese';
  if (lang === 'JP' || lang === 'KO' || lang === 'ID' || lang === 'TH' || lang === 'VI') return 'jpko';
  return 'western';
}

/**
 * The row's own language picks the printing. The batch language is only the
 * fallback before that row has one.
 */
export function remapListingLanguage(rowLanguage = '', batchLanguage = '') {
  return String(rowLanguage || batchLanguage || 'EN').trim() || 'EN';
}

/**
 * Fields a Batch Defaults change writes onto every active row (desk + API
 * `setDefaults` fan-out). Intentionally excluded:
 * - quantity / stack / stackSize / startPosition — capture snapshot + next scan
 * - mergeRepeats — batch rule only
 * - game — host/TCG switch, not a row column
 */
export const BATCH_ROW_FIELDS = ['language', 'condition', 'foilState', 'firstEdition', 'signed', 'altered', 'location'];

export function batchDefaultRowPatch(patch = {}) {
  const out = {};
  for (const key of BATCH_ROW_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
  return out;
}

export function matchesPrintBucket(row, bucket) {
  const n = nationalityOf(row);
  if (bucket === 'western') return n === 'western';
  if (bucket === 'jpko') return n === 'japanese' || n === 'korean';
  if (bucket === 'chinese') return n === 'chinese';
  return false;
}

function bucketRank(row, preferred) {
  const n = nationalityOf(row);
  if (preferred === 'western') {
    if (n === 'western') return 0;
    if (n === 'japanese' || n === 'korean') return 1;
    if (n === 'chinese') return 2;
    return 3;
  }
  if (preferred === 'jpko') {
    if (n === 'japanese' || n === 'korean') return 0;
    if (n === 'western') return 1;
    if (n === 'chinese') return 2;
    return 3;
  }
  if (n === 'chinese') return 0;
  if (n === 'western') return 1;
  if (n === 'japanese' || n === 'korean') return 2;
  return 3;
}

/**
 * Listing language for a printing's nationality.
 * JP Abyss Eye → JP (never EN). Western Pitch Black → EN/IT/… (never JP).
 * Unknown nationality keeps the preferred code so a just-remapped JP sibling
 * is not stomped back to EN before nationality hydrates.
 */
export function listingLanguageForPrint(nationality = '', preferred = 'EN') {
  const n = String(nationality || '').trim().toLowerCase();
  const want = String(preferred || 'EN').trim().toUpperCase() || 'EN';
  if (n === 'japanese') return 'JP';
  if (n === 'korean') return 'KO';
  if (n === 'chinese') return want === 'ZHT' ? 'ZHT' : 'ZH';
  if (!n) return want;
  if (n === 'western' || n === 'european' || n === 'american') {
    if (ASIAN.has(want)) return 'EN';
    return want;
  }
  if (ASIAN.has(want)) return 'EN';
  return want;
}

/**
 * Langs valid for a printing nationality (card desk / sell form).
 * Scan Desk does not use this — it shows the full LANGUAGES list.
 */
export function languagesForPrint(nationality = '', languages = []) {
  const list = [...new Set(
    (languages || []).map((code) => String(code || '').trim().toUpperCase()).filter(Boolean),
  )];
  const n = String(nationality || '').trim().toLowerCase();
  if (n === 'japanese') return ['JP'];
  if (n === 'korean') return ['KO'];
  if (n === 'chinese') return list.filter((code) => code === 'ZH' || code === 'ZHT');
  if (n === 'western' || !n) return list.filter((code) => !ASIAN.has(code));
  return list;
}

/** Preferred print bucket first, then the rest — stable by id. */
export function sortArtworkVersions(printings = [], listingLanguage = '') {
  const preferred = preferredPrintBucket(listingLanguage);
  return [...(printings || [])].sort((a, b) => {
    const d = bucketRank(a, preferred) - bucketRank(b, preferred);
    if (d) return d;
    return printingId(a).localeCompare(printingId(b));
  });
}

/**
 * Manual-add language → artwork remap bucket.
 * Same regions as the queue: western, japanese|korean, chinese.
 */
export function draftArtworkBucket(listingLanguage = '') {
  return preferredPrintBucket(listingLanguage);
}

/**
 * Pick the CLIP sibling that matches the row's listing language region.
 * No sibling in that region → keep the identify/current printing.
 */
export function preferArtworkPrinting(printings = [], currentId = '', listingLanguage = '') {
  const rows = Array.isArray(printings) ? printings : [];
  if (!rows.length) return null;
  const id = String(currentId || '').trim();
  const current = rows.find((row) => printingId(row) === id) || null;
  const bucket = preferredPrintBucket(listingLanguage);
  const match = rows.find((row) => matchesPrintBucket(row, bucket)) || null;
  if (match && (!current || !matchesPrintBucket(current, bucket))) return match;
  return current || rows[0];
}

/** True when the current printing already sits in the language's print region. */
export function currentMatchesLanguageBucket(printings = [], currentId = '', listingLanguage = '') {
  const id = String(currentId || '').trim();
  if (!id) return false;
  const current = (printings || []).find((row) => printingId(row) === id) || null;
  if (!current) return false;
  return matchesPrintBucket(current, preferredPrintBucket(listingLanguage));
}

/**
 * Merge CLIP same-artwork rows with exact-name catalog rows.
 * CLIP sometimes misses a JP/CN sibling that still exists under the same
 * English name (Wondrous Patch Phantasmal Flames ↔ Nihil Zero).
 */
export function mergeArtworkCandidates(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const id = printingId(row);
      if (!id) continue;
      const prev = byId.get(id);
      byId.set(id, prev ? { ...prev, ...row, id, card_id: id } : { ...row, id, card_id: id });
    }
  }
  return [...byId.values()];
}

/** Pick a CLIP sibling for the draft language, or null if this printing already matches. */
export function preferDraftArtwork(printings = [], currentId = '', listingLanguage = '') {
  const bucket = draftArtworkBucket(listingLanguage);
  if (!bucket) return null;
  const rows = Array.isArray(printings) ? printings : [];
  if (!rows.length) return null;
  const id = String(currentId || '').trim();
  const current = rows.find((row) => printingId(row) === id) || null;
  const match = rows.find((row) => matchesPrintBucket(row, bucket)) || null;
  if (match && (!current || !matchesPrintBucket(current, bucket))) return match;
  return null;
}

export function shouldRemapArtwork(printings = [], currentId = '', listingLanguage = '') {
  const preferred = preferArtworkPrinting(printings, currentId, listingLanguage);
  if (!preferred) return false;
  return printingId(preferred) !== String(currentId || '').trim();
}

/**
 * Remap when CLIP has a sibling, or when the current print is outside the
 * language bucket and exact-name candidates can fill that region.
 */
export function resolveArtworkRemap({
  clipPrintings = [],
  namePrintings = [],
  currentId = '',
  listingLanguage = '',
} = {}) {
  const clip = Array.isArray(clipPrintings) ? clipPrintings : [];
  if (shouldRemapArtwork(clip, currentId, listingLanguage)) {
    return preferArtworkPrinting(clip, currentId, listingLanguage);
  }
  if (currentMatchesLanguageBucket(clip, currentId, listingLanguage)) {
    return null;
  }
  const merged = mergeArtworkCandidates(clip, namePrintings);
  if (!shouldRemapArtwork(merged, currentId, listingLanguage)) return null;
  return preferArtworkPrinting(merged, currentId, listingLanguage);
}

/** @deprecated use preferArtworkPrinting */
export function preferWesternPrinting(printings, currentId) {
  return preferArtworkPrinting(printings, currentId, 'EN');
}

/** @deprecated use shouldRemapArtwork */
export function shouldRemapToWestern(printings, currentId) {
  return shouldRemapArtwork(printings, currentId, 'EN');
}

/** Dropdown option / full label with print badge. */
export function artworkVersionLabel(row) {
  if (!row) return '';
  const set = row.set_name || row.setName || row.set || '';
  const number = row.card_number || row.collector_number || row.collectorNumber || row.number || '';
  const base = [set, number].filter(Boolean).join(' · ');
  const badge = printLangBadge(row);
  if (badge && base) return `${badge} · ${base}`;
  return base || badge || String(row.name || printingId(row) || '');
}

/** Compact closed label for the version <select> (LANG column already has EN/JP). */
export function artworkVersionShortLabel(row) {
  if (!row) return '';
  const set = row.set_name || row.setName || row.set || '';
  const number = row.card_number || row.collector_number || row.collectorNumber || row.number || '';
  return [set, number].filter(Boolean).join(' · ') || String(row.name || printingId(row) || '');
}

export { printingId };
