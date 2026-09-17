/**
 * Scan queue: CLIP same-artwork versions + listing-language print preference.
 * Source: GET /api/marketplace-version-set (pokoin_version_sets).
 *
 * Batch Defaults / row language drives the default printing:
 * western langs → western, JP/KO → japanese|korean, ZH/ZHT → chinese.
 *
 * Listing language must match the printing region:
 * western print → western langs only; JP/KO/CN print → no EN/IT/….
 */

import { ASIAN_CARD_LANGS } from './locale.js';
import { printLangBadge } from './card-versions.js';

function printingId(row) {
  return String(row?.id || row?.card_id || row?.cardId || '').trim();
}

function nationalityOf(row) {
  return String(row?.nationality || '').trim().toLowerCase();
}

const ASIAN = new Set(ASIAN_CARD_LANGS.map((c) => String(c).toUpperCase()));

/** @returns {'western'|'jpko'|'chinese'} */
export function preferredPrintBucket(listingLanguage = '') {
  const lang = String(listingLanguage || '').trim().toUpperCase();
  if (lang === 'JP' || lang === 'KO') return 'jpko';
  if (lang === 'ZH' || lang === 'ZHT') return 'chinese';
  return 'western';
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
 */
export function listingLanguageForPrint(nationality = '', preferred = 'EN') {
  const n = String(nationality || '').trim().toLowerCase();
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

/** Dropdown label where the set · collector line used to be. */
export function artworkVersionLabel(row) {
  if (!row) return '';
  const set = row.set_name || row.setName || row.set || '';
  const number = row.card_number || row.collector_number || row.collectorNumber || row.number || '';
  const base = [set, number].filter(Boolean).join(' · ');
  const badge = printLangBadge(row);
  if (badge && base) return `${badge} · ${base}`;
  return base || badge || String(row.name || printingId(row) || '');
}

export { printingId };
