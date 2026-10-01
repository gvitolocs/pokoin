/** Share bounded name-catalog hydration across simultaneous search callers. */
export function createNamePrintingsFetcher({ fetchRows, mapCard, limit = 1000 }) {
  const inflight = new Map();
  return function fetchNamePrintings(name, { lang = 'en' } = {}) {
    const canonical = String(name || '').trim();
    if (!canonical) return Promise.resolve([]);
    const key = JSON.stringify([canonical.toLowerCase(), lang]);
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(() => fetchRows({ name: canonical, lang, limit }))
      .then((rows) => {
        if (!Array.isArray(rows)) throw new Error('Name catalog failed.');
        const byId = new Map();
        for (const row of rows) {
          const card = mapCard(row);
          if (card?.id && !byId.has(String(card.id))) {
            byId.set(String(card.id), { ...card, search_lang: lang });
          }
        }
        return [...byId.values()];
      }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  };
}
