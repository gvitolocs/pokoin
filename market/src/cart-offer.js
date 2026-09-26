import { conditionTone, listingLanguageCode } from './listing-meta.js';

const RANK = { nm: 0, ex: 1, sp: 2, mp: 3, pl: 4, poor: 5 };

function toneRank(offer) {
  const tone = conditionTone(offer?.condition);
  return Object.prototype.hasOwnProperty.call(RANK, tone) ? RANK[tone] : 6;
}

function english(offer) {
  return listingLanguageCode(offer?.language) === 'en';
}

function nearMint(offer) {
  return conditionTone(offer?.condition) === 'nm';
}

function price(offer) {
  const n = Number(offer?.pricePkn);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function inStock(offer) {
  if (offer?.graded) return false;
  if (price(offer) === Infinity) return false;
  const qty = offer?.quantityAvailable;
  if (qty == null || qty === '') return true;
  return Number(qty) > 0;
}

function cheapest(rows) {
  return rows.slice().sort((a, b) => price(a) - price(b))[0] || null;
}

function bestThenCheapest(rows) {
  return rows.slice().sort((a, b) => toneRank(a) - toneRank(b) || price(a) - price(b))[0] || null;
}

/** English Near Mint, then other English conditions, then Near Mint in another language, then the rest. */
export function pickCartOffer(offers) {
  const rows = (offers || []).filter(inStock);
  const home = rows.filter(english);
  const other = rows.filter((row) => !english(row));
  return cheapest(home.filter(nearMint))
    || bestThenCheapest(home.filter((row) => !nearMint(row)))
    || cheapest(other.filter(nearMint))
    || bestThenCheapest(other.filter((row) => !nearMint(row)))
    || null;
}
