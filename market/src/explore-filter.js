/** Explore page (catalog dump in PKN): language facet and the filtered, sorted rows. */

export const EXPLORE_PAGE = 48;

export function exploreLanguages(catalog) {
  if (!catalog) return [];
  return [...new Set((catalog.items || []).map((item) => item.language).filter(Boolean))].sort();
}

/**
 * `watched` is the saved-id list (catalog.js dumpWatchIds); `langs` a Set of
 * language names (empty = any).
 */
export function filterExploreItems(catalog, {
  query = '',
  sort = 'value',
  type = 'all',
  min = '',
  max = '',
  watchOnly = false,
  langs = new Set(),
  watched = [],
} = {}) {
  if (!catalog) return [];
  const needle = String(query || '').trim().toLowerCase();
  const minPkn = Number(min) || 0;
  const maxPkn = Number(max) || Infinity;
  const saved = new Set(watched);
  const rows = (catalog.items || []).filter((item) => {
    if (needle && !`${item.name} ${item.expansion} ${item.game}`.toLowerCase().includes(needle)) return false;
    if (type === 'cards' && item.sealed) return false;
    if (type === 'sealed' && !item.sealed) return false;
    if ((item.pricePkn || 0) < minPkn || (item.pricePkn || 0) > maxPkn) return false;
    if (watchOnly && !saved.has(String(item.id))) return false;
    if (langs.size && item.language && !langs.has(item.language)) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'qty') return (b.qty || 0) - (a.qty || 0) || (b.totalPkn || 0) - (a.totalPkn || 0);
    return (b.totalPkn || 0) - (a.totalPkn || 0);
  });
  return rows;
}
