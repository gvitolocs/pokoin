/** Complete set hydration, shared across concurrent search and set-desk callers. */
export function createExpansionCardsFetcher({ fetchPage, rememberComplete, pageSize = 48, maxPages = 40 }) {
  const inflight = new Map();

  async function load({ slug, expansionName }) {
    const cards = [];
    const seen = new Set();
    let offset = 0;
    let expansion = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await fetchPage({ slug, expansionName, limit: pageSize, offset });
      expansion = data.expansion || expansion;
      const chunk = data.cards || [];
      for (const row of chunk) {
        const id = String(row.id || row.card_id || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          cards.push(row);
        }
      }
      // The legacy SQL hasMore flag can be false on a full first page.
      // Keep paging until a short page, with an explicit upper bound.
      if (chunk.length < pageSize) {
        return rememberComplete({ slug, expansionName }, { cards, hasMore: false, expansion });
      }
      offset += chunk.length;
    }
    return { cards, hasMore: true, expansion };
  }

  return function fetchExpansionCards({ slug = '', expansionName = '' } = {}) {
    const key = JSON.stringify({ slug, expansionName });
    if (inflight.has(key)) {
      return inflight.get(key);
    }
    // Share later pages too. Releasing on either outcome allows a retry.
    const pending = load({ slug, expansionName }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  };
}
