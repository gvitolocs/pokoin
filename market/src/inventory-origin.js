/**
 * Where a seller's listing came from, and which live listings look like the
 * same copy reached Pokoin through two channels (docs/INVENTORY_ORIGIN.md).
 * The Rust twin is `pokoin-rust/crates/commerce/src/listing_origin.rs`.
 * Read-only flagging: nothing here merges or deletes a listing.
 */

import { isLiveInventoryListing } from './inventory-listings.js';

/** Origin ids in the order the inventory filter lists them. */
export const ORIGINS = ['pokoin', 'cardrails', 'cardtrader', 'cardmarket', 'tcgplayer', 'csv'];

export const ORIGIN_LABELS = {
  cardrails: 'Card Rails',
  cardtrader: 'CardTrader',
  cardmarket: 'Cardmarket',
  tcgplayer: 'TCGplayer',
  csv: 'CSV import',
  pokoin: 'Pokoin',
};

const CARDTRADER_SOURCES = new Set(['cardtrader_seller_import', 'cardtrader_csv_import', 'cardtrader_live', 'cardtrader']);
const CARDMARKET_SOURCES = new Set(['powertools_csv_import', 'cardmarket_csv_import']);

/**
 * Origin of one listing row. An `origin` the API computed wins (it knows the
 * Card Rails connector keys); then an import `source`, then the Card Rails
 * key, then the source listing id prefix. The import beats the key: Card Rails
 * also binds keys to listings it pulled in from an existing CardTrader import,
 * and those came from CardTrader. A `ct:` id alone says nothing: Pokoin rows
 * pushed to CardTrader carry one too.
 */
export function listingOrigin(row) {
  const given = String(row?.origin ?? '').trim().toLowerCase();
  if (given && ORIGINS.includes(given)) return given;
  const source = String(row?.source ?? '').trim().toLowerCase();
  const id = String(row?.sourceListingId ?? row?.source_listing_id ?? '').trim().toLowerCase();
  if (CARDTRADER_SOURCES.has(source)) return 'cardtrader';
  if (CARDMARKET_SOURCES.has(source)) return 'cardmarket';
  if (source === 'tcgplayer_csv_import') return 'tcgplayer';
  if (source === 'stock_csv_import') return 'csv';
  if (row?.cardrailsKey === true || row?.cardrails_key === true) return 'cardrails';
  if (id.startsWith('pt:') || id.startsWith('cm:')) return 'cardmarket';
  if (id.startsWith('tp:')) return 'tcgplayer';
  return 'pokoin';
}

export function originLabel(origin) {
  return ORIGIN_LABELS[origin] || ORIGIN_LABELS.pokoin;
}

function finishOf(row) {
  const foil = String(row?.foilState ?? row?.foil_state ?? '').trim().toLowerCase() || 'standard';
  return foil === 'standard' && row?.reverse === true ? 'reverse' : foil;
}

function gradedOf(row) {
  const company = String(row?.gradingCompany ?? row?.grading_company ?? '').trim().toUpperCase();
  const grade = String(row?.grade ?? '').trim().toUpperCase();
  const cert = String(row?.certificationId ?? row?.certification_id ?? '').trim().toUpperCase();
  if (row?.graded !== true && !company && !grade && !cert) return '';
  return `graded:${cert || `${company}${grade ? ` ${grade}` : ''}`}`;
}

/**
 * Same physical printing in the same state: card id, condition, language,
 * finish, first edition, and the slab for graded copies. '' without a card id.
 */
export function duplicateKey(row) {
  const cardId = String(row?.cardId ?? row?.card_id ?? '').trim();
  if (!cardId) return '';
  const parts = [
    cardId,
    String(row?.condition || '').trim().toUpperCase() || 'NM',
    String(row?.language || '').trim().toUpperCase() || 'EN',
    finishOf(row),
    (row?.firstEdition ?? row?.first_edition) === true ? '1st' : '',
  ];
  const graded = gradedOf(row);
  if (graded) parts.push(graded);
  return parts.join('|');
}

const qtyOf = (row) => Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0);

/** Only a box·stack·position location identifies an exact physical slot. */
export function exactSlot(row) {
  const location = String(row?.location ?? '').trim().toLowerCase();
  const match = /^([^·]+)·\d+·\d+$/.exec(location);
  return match && match[1].trim() ? location : '';
}

export function provenSeparate(a, b) {
  const slotA = exactSlot(a);
  const slotB = exactSlot(b);
  return Boolean(slotA && slotB && slotA !== slotB);
}

/**
 * Live rows grouped by `duplicateKey`; flag each row with another origin's
 * copy unless their exact slots prove them separate. Flagged rows map to
 * `{ key, origins, others }`, with only those possible duplicates in others.
 * Same-origin copies (three scans of one card) are not duplicates.
 */
export function findCrossSourceDuplicates(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isLiveInventoryListing(row)) continue;
    const key = duplicateKey(row);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push({ row, origin: listingOrigin(row) });
    groups.set(key, group);
  }
  const out = new Map();
  for (const [key, group] of groups) {
    for (const { row, origin } of group) {
      const others = group
        .filter((entry) => entry.origin !== origin && !provenSeparate(row, entry.row))
        .map((entry) => ({ id: String(entry.row?.id ?? ''), origin: entry.origin, quantity: qtyOf(entry.row) }));
      if (!others.length) continue;
      const origins = ORIGINS.filter((id) => id === origin || others.some((entry) => entry.origin === id));
      out.set(String(row?.id ?? ''), { key, origins, others });
    }
  }
  return out;
}

/**
 * Live rows with the candidate's key from an origin other than `origin`:
 * a card about to be listed that the book already holds from another channel.
 */
export function existingDuplicatesFor(rows, candidate, { origin = 'pokoin' } = {}) {
  const key = duplicateKey(candidate);
  if (!key) return [];
  // Scan Desk assigns the new row's location itself: a differing scan slot is not evidence of separate copies.
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => isLiveInventoryListing(row) && duplicateKey(row) === key && listingOrigin(row) !== origin);
}

/** "Card Rails (qty 1), CardTrader (qty 2)": summed copies per origin. */
export function describeOrigins(entries) {
  const byOrigin = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const origin = entry?.origin || listingOrigin(entry);
    const quantity = entry?.quantity ?? qtyOf(entry);
    byOrigin.set(origin, (byOrigin.get(origin) || 0) + (Number(quantity) || 0));
  }
  return ORIGINS.filter((origin) => byOrigin.has(origin))
    .map((origin) => `${originLabel(origin)} (qty ${byOrigin.get(origin)})`)
    .join(', ');
}

/** Origin counts present in the rows, in ORIGINS order, for the filter select. */
export function originFacets(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const origin = listingOrigin(row);
    counts.set(origin, (counts.get(origin) || 0) + 1);
  }
  return ORIGINS.filter((origin) => counts.has(origin)).map((origin) => ({ id: origin, label: originLabel(origin), count: counts.get(origin) }));
}
