import { mergeHomeRail, tileHasName } from './lists.js';
import { isSetDeskCard } from './search-filters.js';

/** How many tiles the landing rail shows (the Rust rail serves 12). */
export const LANDING_RAIL_LIMIT = 12;

/**
 * Tiles of one dedicated home rail (fetchHomeRail), in the rail's order, with
 * the same filters as the marketplace Home carousels.
 */
export function railTiles(rail, limit = LANDING_RAIL_LIMIT) {
  if (!rail?.cards?.length || !rail.sectionKey) return [];
  const vector = mergeHomeRail(null, rail);
  const byId = new Map((vector.cards || []).map((card) => [String(card.id), card]));
  return (vector.sections?.[rail.sectionKey] || [])
    .map((id) => byId.get(String(id)))
    .filter(tileHasName)
    .filter(isSetDeskCard)
    .slice(0, limit);
}
