// Relative so node --test can load this module (it does not apply the Vite @market alias).
import { describeOrigins, duplicateKey, existingDuplicatesFor } from '../../../../market/src/inventory-origin.js';

// Book array → its live rows by duplicate key, built once per book: every
// scan row then costs one key, not a pass over thousands of listings.
const indexes = new WeakMap();

function bookIndex(book) {
  let index = indexes.get(book);
  if (!index) {
    index = new Map();
    for (const row of book) {
      const key = duplicateKey(row);
      if (!key) continue;
      const list = index.get(key) || [];
      list.push(row);
      index.set(key, list);
    }
    indexes.set(book, index);
  }
  return index;
}

/**
 * The seller's live listings of the same copy a scan row is about to list,
 * from another channel (Card Rails, CardTrader, Cardmarket…): a scan row
 * carries the listing field names already (cardId, condition, language,
 * foilState, firstEdition, graded…). Warning only: never blocks the submit.
 */
export function scanRowDuplicates(book, row) {
  if (!Array.isArray(book) || !book.length) return [];
  if (!row || row.status === 'submitted') return [];
  const key = duplicateKey(row);
  if (!key) return [];
  return existingDuplicatesFor(bookIndex(book).get(key) || [], row, { origin: 'pokoin' });
}

/** Name existing copies and up to two locations; '' when nothing matches. */
export function scanDuplicateNote(book, row) {
  const matches = scanRowDuplicates(book, row);
  if (!matches.length) return '';
  const locations = [...new Set(matches.map((match) => String(match.location ?? '').trim()).filter(Boolean))];
  const more = locations.length > 2 ? ` +${locations.length - 2} more` : '';
  const where = locations.length ? ` · ${locations.slice(0, 2).join(', ')}${more}` : '';
  return `Already listed from ${describeOrigins(matches)}${where}`;
}
