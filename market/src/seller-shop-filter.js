/** Local shop filters. Same rules as the seller-shop API (pokoin-rust/crates/commerce/src/handlers/seller.rs), applied to a
 * book already downloaded for this seller. */

const CONDITION_CODES = {
  NM: ['NM', 'M'],
  M: ['NM', 'M'],
  SP: ['SP', 'LP'],
  LP: ['SP', 'LP'],
  MP: ['MP'],
  PL: ['PL', 'HP'],
  HP: ['PL', 'HP'],
  POOR: ['PO', 'POOR', 'D', 'DMG'],
  PO: ['PO', 'POOR', 'D', 'DMG'],
  D: ['PO', 'POOR', 'D', 'DMG'],
  DMG: ['PO', 'POOR', 'D', 'DMG'],
};

function conditionCodes(condition) {
  const raw = String(condition || '').trim().toUpperCase();
  if (!raw) return null;
  return CONDITION_CODES[raw] || null;
}

function includes(text, pattern) {
  return String(text || '').toLowerCase().includes(pattern);
}

function matchesRarity(row, rarity) {
  const key = String(rarity || '').trim().toLowerCase();
  if (!key) return true;
  const text = String(row.rarity || '').toLowerCase();
  const foil = String(row.foilState || row.foil_state || '').toLowerCase();
  if (key === 'holo') {
    return foil === 'holo' || foil === 'holofoil' || includes(text, 'holo');
  }
  if (key === 'common') return includes(text, 'common') && !includes(text, 'uncommon');
  if (key === 'uncommon') return includes(text, 'uncommon');
  if (key === 'rare') {
    return includes(text, 'rare')
      && !includes(text, 'ultra')
      && !includes(text, 'secret')
      && !includes(text, 'illustration')
      && !includes(text, 'amazing')
      && !includes(text, 'uncommon');
  }
  if (key === 'ultra') return includes(text, 'ultra');
  if (key === 'illustration') return includes(text, 'illustration');
  if (key === 'secret') return includes(text, 'secret');
  if (key === 'promo') return includes(text, 'promo');
  if (key === 'no-rarity') return includes(text, 'no rarity');
  return true;
}

/** What a filter or a sort reads from a row, worked out once per book. */
function rowKey(row) {
  const price = Number(row.pricePkn);
  return {
    row,
    price: Number.isFinite(price) ? price : Number.POSITIVE_INFINITY,
    name: String(row.cardName || '').toLowerCase(),
    qty: Number(row.quantityAvailable) || 0,
    updated: timeValue(row.updatedAt),
    created: timeValue(row.createdAt),
    hay: `${row.cardName || ''} ${row.setName || ''} ${row.collectorNumber || ''}`.toLowerCase(),
    condition: String(row.condition || '').trim().toUpperCase(),
    language: String(row.language || '').trim().toUpperCase(),
  };
}

function matchesKey(key, filters) {
  if (filters.q && !key.hay.includes(filters.q)) return false;
  if (filters.codes && !filters.codes.includes(key.condition)) return false;
  if (filters.language && !key.language.startsWith(filters.language)) return false;
  if (filters.reverse && key.row.reverse !== true) return false;
  if (filters.firstEdition && key.row.firstEdition !== true) return false;
  if (filters.rarity && !matchesRarity(key.row, filters.rarity)) return false;
  return true;
}

function timeValue(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

const collator = new Intl.Collator();

function compareKeys(sort, a, b) {
  const updated = b.updated - a.updated;
  switch (sort) {
    case 'price-desc':
      return (b.price - a.price) || updated || (b.created - a.created);
    case 'qty':
      return (b.qty - a.qty) || (a.price - b.price) || updated;
    case 'name':
      return collator.compare(a.name, b.name) || (a.price - b.price);
    case 'price-asc':
    default:
      return (a.price - b.price) || updated || (b.created - a.created);
  }
}

const SORTS = new Set(['price-desc', 'qty', 'name', 'price-asc']);
/** listings array → { keys, sorted: Map<sort, keys in that order> }. */
const INDEXES = new WeakMap();

function indexFor(listings) {
  let index = INDEXES.get(listings);
  if (!index) {
    index = { keys: listings.map(rowKey), sorted: new Map() };
    INDEXES.set(listings, index);
  }
  return index;
}

function sortedKeys(index, sort) {
  let keys = index.sorted.get(sort);
  if (!keys) {
    // Infinity - Infinity is NaN: two unpriced rows keep their order.
    keys = index.keys.slice().sort((a, b) => compareKeys(sort, a, b) || 0);
    index.sorted.set(sort, keys);
  }
  return keys;
}

/**
 * Filter and sort a seller's book. The book is indexed once (lowercased text,
 * numeric price and dates) and each order is sorted once, so a filter click
 * on a ten-thousand-row shop is one pass over ready keys.
 */
export function filterSellerBook(listings, filters = {}) {
  if (!Array.isArray(listings)) return { rows: [], unique: 0, copies: 0 };
  const requested = String(filters.sort || '').toLowerCase();
  const sort = SORTS.has(requested) ? requested : 'price-asc';
  const wanted = {
    q: String(filters.q || '').trim().toLowerCase(),
    codes: conditionCodes(filters.condition),
    language: String(filters.language || '').trim().toUpperCase(),
    reverse: Boolean(filters.reverse),
    firstEdition: Boolean(filters.firstEdition),
    rarity: String(filters.rarity || '').trim(),
  };
  const rows = [];
  let copies = 0;
  for (const key of sortedKeys(indexFor(listings), sort)) {
    if (!matchesKey(key, wanted)) continue;
    rows.push(key.row);
    copies += key.qty;
  }
  return { rows, unique: rows.length, copies };
}
