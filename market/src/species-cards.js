import { fetchSearch } from './api.js';
import { exactNameQuery, filterExactNameRows } from './exact-name.js';

/** Every printing of this Pokémon name, up to the cart bundle cap. */
export async function fetchSpeciesCards(name, { limit = 400 } = {}) {
  const query = exactNameQuery(name);
  const wanted = String(name || '').trim();
  if (!query || !wanted) return [];
  const cap = Math.max(1, Math.min(400, Math.trunc(Number(limit)) || 400));
  const out = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < 8 && out.length < cap; page += 1) {
    const data = await fetchSearch({
      query,
      offset,
      limit: 48,
      productType: 'card',
    });
    const raw = data?.cards || [];
    for (const row of filterExactNameRows(raw, wanted)) {
      const id = String(row?.id || row?.card_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      if (out.length >= cap) break;
    }
    if (!data?.hasMore || !raw.length) break;
    offset += raw.length;
  }
  return out;
}
