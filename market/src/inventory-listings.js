/**
 * Seller inventory only surfaces listings that can still appear on a card desk.
 * Cancelled (inactive) and sold-out rows stay in Postgres for history but must
 * not look like live inventory links.
 */

export function isLiveInventoryListing(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || 'active').toLowerCase();
  if (status !== 'active' && status !== 'paused') return false;
  return Number(row.quantityAvailable ?? row.quantity_available ?? 0) > 0;
}

export function liveInventoryListings(rows) {
  return (Array.isArray(rows) ? rows : []).filter(isLiveInventoryListing);
}

/** Card count and summed asking PKN for live inventory rows only. */
export function summarizeLiveInventory(rows) {
  const live = liveInventoryListings(rows);
  let cards = 0;
  let listedPkn = 0;
  for (const row of live) {
    const qty = Math.max(0, Number(row.quantityAvailable ?? row.quantity_available ?? 0) || 0);
    const price = Math.max(0, Number(row.pricePkn ?? row.price_pkn ?? 0) || 0);
    cards += qty;
    listedPkn += price * qty;
  }
  return {
    listings: live.length,
    cards,
    listedPkn,
  };
}

export function inventoryListingHref(row) {
  const path = String(row?.canonicalPath || row?.canonical_path || '').trim();
  if (path.startsWith('/marketplace/')) return path;
  const id = String(row?.cardId || row?.card_id || '').trim();
  if (/^\d+$/.test(id)) return `/marketplace/en/cards/${id}`;
  return '/marketplace';
}

export function inventoryListingMeta(row, formatPkn) {
  const price = typeof formatPkn === 'function'
    ? formatPkn(row?.pricePkn ?? row?.price_pkn)
    : `${row?.pricePkn ?? row?.price_pkn ?? 0} PKN`;
  const parts = [
    price,
    row?.condition || 'NM',
    `qty ${row?.quantityAvailable ?? row?.quantity_available ?? 1}`,
  ];
  const status = String(row?.status || '').toLowerCase();
  if (status === 'paused') parts.push('paused');
  const language = String(row?.language || '').trim().toUpperCase();
  if (language && language !== 'EN') parts.push(language);
  const loc = String(row?.location || '').trim();
  if (loc) parts.push(loc);
  return parts.join(' · ');
}

/** Short listed date for the inventory table (e.g. 30/09). */
export function inventoryRowDate(row) {
  const raw = String(row?.createdAt || row?.created_at || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  return `${match[3]}/${match[2]}`;
}

/** Row name searched case-insensitively across name, set, collector and location. */
function inventoryRowHaystack(row) {
  return [
    row?.cardName || row?.name,
    row?.setName || row?.set_name,
    row?.collectorNumber || row?.collector_number,
    row?.location,
  ]
    .map((part) => String(part || '').toLowerCase())
    .join(' ');
}

/** PowerTools-style client filters: text query, status, condition, language. */
export function filterInventoryRows(rows, { query = '', status = '', condition = '', language = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = String(query || '').trim().toLowerCase();
  const wantStatus = String(status || '').toLowerCase();
  const wantCondition = String(condition || '').toUpperCase();
  const wantLanguage = String(language || '').toUpperCase();
  return list.filter((row) => {
    if (needle && !inventoryRowHaystack(row).includes(needle)) return false;
    if (wantStatus) {
      const rowStatus = String(row?.status || 'active').toLowerCase();
      if (rowStatus !== wantStatus) return false;
    }
    if (wantCondition) {
      const rowCondition = String(row?.condition || 'NM').toUpperCase();
      if (rowCondition !== wantCondition) return false;
    }
    if (wantLanguage) {
      const rowLanguage = String(row?.language || '').toUpperCase();
      if (rowLanguage !== wantLanguage) return false;
    }
    return true;
  });
}

export const INVENTORY_SORTS = ['newest', 'oldest', 'price-up', 'price-down', 'qty-down', 'name'];

/** Sort rows for the inventory table. */
export function sortInventoryRows(rows, sort = 'newest') {
  const list = [...(Array.isArray(rows) ? rows : [])];
  const price = (row) => Number(row?.pricePkn ?? row?.price_pkn ?? 0) || 0;
  const qty = (row) => Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0;
  const created = (row) => String(row?.createdAt || row?.created_at || '');
  const name = (row) => String(row?.cardName || row?.name || '').toLowerCase();
  switch (sort) {
    case 'oldest':
      return list.sort((a, b) => created(a).localeCompare(created(b)));
    case 'price-up':
      return list.sort((a, b) => price(a) - price(b));
    case 'price-down':
      return list.sort((a, b) => price(b) - price(a));
    case 'qty-down':
      return list.sort((a, b) => qty(b) - qty(a));
    case 'name':
      return list.sort((a, b) => name(a).localeCompare(name(b)));
    case 'newest':
    default:
      return list.sort((a, b) => created(b).localeCompare(created(a)));
  }
}

/** Distinct condition/language keys present in the rows, for the filter selects. */
export function inventoryFacets(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const conditions = new Set();
  const languages = new Set();
  for (const row of list) {
    const condition = String(row?.condition || 'NM').trim().toUpperCase();
    if (condition) conditions.add(condition);
    const language = String(row?.language || '').trim().toUpperCase();
    if (language) languages.add(language);
  }
  return {
    conditions: [...conditions].sort(),
    languages: [...languages].sort(),
  };
}

/** Stack key: identical printing in the same grade + foil facets. */
export function inventoryStackKey(row) {
  const facets = [
    row?.cardId || row?.card_id,
    String(row?.condition || 'NM').toUpperCase(),
    String(row?.language || '').toUpperCase(),
    row?.reverse === true ? 'rev' : '',
    (row?.firstEdition ?? row?.first_edition) === true ? '1st' : '',
    row?.graded === true ? 'graded' : '',
  ];
  return facets.map((part) => String(part ?? '')).join('|');
}

/**
 * Group location rows into stacks — same printing, grade and foil facets —
 * with the posting count and summed copies per stack. Ordered by posting
 * count desc (the busiest stack first), then copies, then name.
 */
export function groupInventoryStacks(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const stacks = new Map();
  for (const row of list) {
    const key = inventoryStackKey(row);
    const stack = stacks.get(key) || {
      key,
      cardId: row?.cardId || row?.card_id,
      cardName: row?.cardName || row?.name || 'Listing',
      setName: row?.setName || row?.set_name || '',
      collectorNumber: row?.collectorNumber || row?.collector_number || '',
      cardImageUrl: row?.cardImageUrl || row?.card_image_url || '',
      condition: row?.condition || 'NM',
      language: row?.language || '',
      location: row?.location || '',
      postings: [],
    };
    stack.postings.push(row);
    stacks.set(key, stack);
  }
  const grouped = [...stacks.values()];
  for (const stack of grouped) {
    stack.postingCount = stack.postings.length;
    stack.copies = stack.postings.reduce(
      (sum, row) => sum + Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0),
      0,
    );
  }
  return grouped.sort((a, b) =>
    b.postingCount - a.postingCount
    || b.copies - a.copies
    || a.cardName.localeCompare(b.cardName));
}
