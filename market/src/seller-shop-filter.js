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

function matchesRow(row, filters) {
  const q = String(filters.q || '').trim().toLowerCase();
  if (q) {
    const hay = `${row.cardName || ''} ${row.setName || ''} ${row.collectorNumber || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const codes = conditionCodes(filters.condition);
  if (codes && !codes.includes(String(row.condition || '').trim().toUpperCase())) return false;
  const language = String(filters.language || '').trim().toUpperCase();
  if (language && !String(row.language || '').trim().toUpperCase().startsWith(language)) return false;
  if (filters.reverse && row.reverse !== true) return false;
  if (filters.firstEdition && row.firstEdition !== true) return false;
  if (!matchesRarity(row, filters.rarity)) return false;
  return true;
}

function timeValue(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compareRows(sort, a, b) {
  const priceA = Number(a.pricePkn);
  const priceB = Number(b.pricePkn);
  const pa = Number.isFinite(priceA) ? priceA : Number.POSITIVE_INFINITY;
  const pb = Number.isFinite(priceB) ? priceB : Number.POSITIVE_INFINITY;
  const nameA = String(a.cardName || '').toLowerCase();
  const nameB = String(b.cardName || '').toLowerCase();
  const qtyA = Number(a.quantityAvailable) || 0;
  const qtyB = Number(b.quantityAvailable) || 0;
  const updated = timeValue(b.updatedAt) - timeValue(a.updatedAt);
  const created = timeValue(b.createdAt) - timeValue(a.createdAt);
  switch (String(sort || '').toLowerCase()) {
    case 'price-desc':
      return (pb - pa) || updated || created;
    case 'qty':
      return (qtyB - qtyA) || (pa - pb) || updated;
    case 'name':
      return nameA.localeCompare(nameB) || (pa - pb);
    case 'price-asc':
    default:
      return (pa - pb) || updated || created;
  }
}

export function filterSellerBook(listings, filters = {}) {
  const rows = (Array.isArray(listings) ? listings : []).filter((row) => matchesRow(row, filters));
  rows.sort((a, b) => compareRows(filters.sort, a, b));
  const copies = rows.reduce((sum, row) => sum + (Number(row.quantityAvailable) || 0), 0);
  return { rows, unique: rows.length, copies };
}
