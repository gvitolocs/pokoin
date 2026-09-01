const CATALOG_URL = `${import.meta.env.BASE_URL || '/'}data/catalog.json`;

let cache = null;
let inflight = null;

export function loadCatalog() {
  if (cache) {
    return Promise.resolve(cache);
  }
  if (!inflight) {
    inflight = fetch(CATALOG_URL, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Catalog dump missing');
        }
        return response.json();
      })
      .then((data) => {
        cache = data;
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function usdMoney(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function isPokemonSingle(item) {
  return /pok[eé]mon/i.test(item?.game || '') && /single/i.test(item?.category || '');
}

export function dumpItemHref(item) {
  return item?.id != null ? `/marketplace/portfolio/${item.id}` : '/marketplace/portfolio';
}

/** Public card_id is CardTrader blueprint × 2. Never divide. */
export function dumpMarketplaceHref(item) {
  const blueprint = Number(item?.blueprint);
  if (isPokemonSingle(item) && Number.isSafeInteger(blueprint) && blueprint > 0) {
    return `/marketplace/en/cards/${blueprint * 2}`;
  }
  const query = String(item?.name || '').trim();
  return query ? `/marketplace/search?q=${encodeURIComponent(query)}` : '/marketplace/search';
}

export function dumpSearchHref(item) {
  const query = [item?.name, item?.expansion].filter(Boolean).join(' ').trim();
  return query ? `/marketplace/search?q=${encodeURIComponent(query)}` : '/marketplace/search';
}

export function catalogItemById(catalog, id) {
  return (catalog?.items || []).find((item) => String(item.id) === String(id)) || null;
}

export function finishLabel(item) {
  if (item?.category && ['Boosters', 'Booster box', 'Bundle'].includes(item.category)) {
    return 'Sealed';
  }
  if (item?.foil) {
    return 'Holofoil';
  }
  return item?.condition || item?.category || '—';
}

export const SEALED_CATEGORIES = new Set(['Boosters', 'Booster box', 'Bundle']);

export function isSealed(item) {
  return SEALED_CATEGORIES.has(item?.category);
}

const DUMP_WATCH_KEY = 'pokoin.dumpWatchIds';

export function dumpWatchIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DUMP_WATCH_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function dumpWatched(id) {
  return dumpWatchIds().includes(String(id));
}

export function toggleDumpWatch(id) {
  const key = String(id || '');
  if (!key) return false;
  const current = dumpWatchIds();
  const on = current.includes(key);
  const next = on ? current.filter((value) => value !== key) : [key, ...current].slice(0, 200);
  localStorage.setItem(DUMP_WATCH_KEY, JSON.stringify(next));
  return !on;
}
