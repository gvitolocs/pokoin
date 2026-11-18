/**
 * `GET /api/cardmarket-matches` answer → what the CM pill does. `primary` is
 * what /api/cardmarket-redirect opens; `matches` are every stored verified
 * Cardmarket product (Prize Pack reprints, V1/V2 promos), in source order.
 */

function cardmarketHttpUrl(value) {
  const url = String(value || '').trim();
  return /^https:\/\/(?:www\.)?cardmarket\.com\//i.test(url) ? url : '';
}

/** `{ primary, matches: [{ url, label, source }] }`, deduped by URL. Junk rows are dropped. */
export function cardmarketChoices(data) {
  const primary = cardmarketHttpUrl(data?.primary);
  const seen = new Set();
  const matches = [];
  for (const row of Array.isArray(data?.matches) ? data.matches : []) {
    const url = cardmarketHttpUrl(row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    matches.push({ url, label: String(row.label || '').trim() || 'Cardmarket', source: String(row.source || '') });
  }
  return { primary, matches };
}

/** True when the pill should open the chooser instead of a single page. */
export function needsCardmarketChooser(choices) {
  return (choices?.matches?.length || 0) > 1;
}
