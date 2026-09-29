/**
 * Scan queue: CLIP same-artwork versions + listing-language print preference.
 * Source: GET /api/marketplace-version-set (pokoin_version_sets).
 *
 * Batch Defaults / row language drives the default printing:
 * western langs → western, JP/KO → japanese|korean, ZH/ZHT → chinese,
 * ID/TH → their own print (never western). Same families as the phone's
 * printing choice (CardVault api/_scan_connect.js printFamily), so the desk
 * never remaps a printing the seller picked on the phone.
 * Nationality goes through the canonical print bucket: american / french /
 * german prints (e.g. Trick or Trade) are western.
 *
 * Listing language must match the printing region:
 * western print → western langs only; JP/KO/CN print → no EN/IT/….
 */

import { ASIAN_CARD_LANGS } from './locale.js';
import { printLangBadge } from './card-versions.js';
import { printBucket } from './print-bucket.js';

function printingId(row) {
  return String(row?.id || row?.card_id || row?.cardId || '').trim();
}

/** Print region of a printing (`print-bucket.js`: american → western, …). */
function nationalityOf(row) {
  return printBucket(row?.nationality);
}

const ASIAN = new Set(ASIAN_CARD_LANGS.map((c) => String(c).toUpperCase()));

// Print regions each preferred bucket accepts.
const BUCKET_REGIONS = {
  western: ['western'],
  jpko: ['japanese', 'korean'],
  chinese: ['chinese'],
  indonesian: ['indonesian', 'idth'],
  thai: ['thai', 'idth'],
  vietnamese: [],
};

/** @returns {'western'|'jpko'|'chinese'|'indonesian'|'thai'|'vietnamese'} */
export function preferredPrintBucket(listingLanguage = '') {
  const lang = String(listingLanguage || '').trim().toUpperCase();
  if (lang === 'JP' || lang === 'KO') return 'jpko';
  if (lang === 'ZH' || lang === 'ZHT') return 'chinese';
  if (lang === 'ID') return 'indonesian';
  if (lang === 'TH') return 'thai';
  if (lang === 'VI') return 'vietnamese';
  return 'western';
}

export function matchesPrintBucket(row, bucket) {
  return (BUCKET_REGIONS[bucket] || []).includes(nationalityOf(row));
}

// Preferred region first, then western, Japanese/Korean, Chinese, the rest.
const FALLBACK_ORDER = ['western', 'jpko', 'chinese'];

function bucketRank(row, preferred) {
  if (matchesPrintBucket(row, preferred)) return 0;
  const i = FALLBACK_ORDER.filter((b) => b !== preferred).findIndex((b) => matchesPrintBucket(row, b));
  return i < 0 ? FALLBACK_ORDER.length : i + 1;
}

/**
 * Listing language for a printing's nationality.
 * JP Abyss Eye → JP (never EN). Western Pitch Black → EN/IT/… (never JP).
 */
export function listingLanguageForPrint(nationality = '', preferred = 'EN') {
  const n = printBucket(nationality);
  const want = String(preferred || 'EN').trim().toUpperCase() || 'EN';
  if (n === 'japanese') return 'JP';
  if (n === 'korean') return 'KO';
  if (n === 'chinese') return want === 'ZHT' ? 'ZHT' : 'ZH';
  if (ASIAN.has(want)) return 'EN';
  return want;
}

/** LANG select options for this printing. */
export function languagesForPrint(nationality = '', languages = []) {
  const list = [...new Set(
    (languages || []).map((code) => String(code || '').trim().toUpperCase()).filter(Boolean),
  )];
  const raw = String(nationality || '').trim();
  const n = printBucket(raw);
  if (n === 'japanese') return ['JP'];
  if (n === 'korean') return ['KO'];
  if (n === 'chinese') return list.filter((code) => code === 'ZH' || code === 'ZHT');
  if (n === 'western' || !raw) return list.filter((code) => !ASIAN.has(code));
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
 * JP/KO/ID/TH/VI → japanese|korean sibling. Western → western.
 * ZH/ZHT → null (do not auto-change the expansion).
 */
export function draftArtworkBucket(listingLanguage = '') {
  const lang = String(listingLanguage || '').trim().toUpperCase();
  if (lang === 'ZH' || lang === 'ZHT') return null;
  if (lang === 'JP' || lang === 'KO' || lang === 'ID' || lang === 'TH' || lang === 'VI') return 'jpko';
  return 'western';
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

/** Pick a CLIP sibling for the draft language, or null if none / Chinese. */
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
