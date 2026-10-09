import { printBucket } from './locale.js';
import { searchRarity } from './search-filters.js';
import { raritySlug } from './seo.js';

/**
 * Pure rules behind the public browse pages (Sets, rarity / language hubs,
 * artist index). Shared by the React pages and the Solid port so both UIs
 * list exactly the same rows.
 */

/** Satellite TCG set list: one "Sets" group, A → Z, filtered by name or slug. */
export function satelliteGroups(expansions, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const rows = (expansions || [])
    .filter((row) => {
      if (!needle) return true;
      const blob = `${row.name || ''} ${row.slug || ''}`.toLowerCase();
      return blob.includes(needle);
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en'));
  return rows.length ? [['Sets', rows]] : [];
}

/** A search row belongs on a rarity hub (promo / full-art match loosely). */
export function rarityMatches(card, hub) {
  const value = raritySlug(searchRarity(card));
  if (!value) {
    return false;
  }
  if (value === hub.slug) {
    return true;
  }
  if (hub.slug === 'promo') {
    return value.includes('promo');
  }
  if (hub.slug === 'full-art') {
    return value.includes('full-art') || value.includes('fullart');
  }
  return value.includes(hub.slug);
}

/** An expansion belongs on a print-language hub; Western also takes American and European prints. */
export function languageMatches(row, hub) {
  const bucket = printBucket(row.nationality);
  if (hub.nationality === 'western') {
    return bucket === 'western' || bucket === 'american' || bucket === 'european';
  }
  return bucket === hub.nationality;
}

/** Printings credited to an artist summary row. */
export function artistCardCount(row) {
  return Number(row?.count || row?.cardCount || 0);
}
