// The data rules behind the /cart rails and live re-check, without a UI
// framework: cart-rails.js wraps them in React hooks, the Solid cart page in
// signals. Requests and merges only.

import {
  fetchCardTiles,
  fetchListings,
  fetchSellerByUsername,
  peekRecentTile,
} from './api.js';
import { buyAgainCards, isSelected } from './cart-model.js';
import { sellerHandle } from './listing-meta.js';
import { countryFromLocale } from './pkn.js';
import { SHIP_TO_COUNTRIES } from './ship-countries.js';
import { fetchSpeciesCards } from './species-cards.js';

function shipToCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return SHIP_TO_COUNTRIES.some((row) => row.code === code) ? code : '';
}

/**
 * Amazon's "Deliver to …": the country picked in the buyer's profile, else
 * the default saved address country (masked list, no street data), else the
 * browser locale — the country checkout quotes first.
 */
export function deliveryCountryFrom(accountCountry, profileCountry = '') {
  const profile = shipToCode(profileCountry);
  if (profile) return { country: profile, saved: true };
  const account = shipToCode(accountCountry);
  if (account) return { country: account, saved: true };
  const locale = shipToCode(countryFromLocale());
  return { country: locale || 'DK', saved: false };
}

/** The profile country (GET /api/seller-settings shipFromCountry). */
export function profileCountryFrom(settings) {
  return shipToCode(settings?.shipFromCountry);
}

/** The preferred saved address's country from GET /api/account-addresses. */
export function preferredAddressCountry(data) {
  const list = Array.isArray(data?.addresses) ? data.addresses : [];
  const preferred = list.find((row) => row.isDefault) || list[0];
  return String(preferred?.countryCode || '').toUpperCase();
}

/** Listings per card for the re-check; fewer rows back means the whole book. */
export const LIVE_LIMIT = 200;
export const LIVE_WIDTH = 4;
export const RECHECK_AFTER_MS = 2 * 60 * 1000;

export async function runPool(list, width, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const item = list[cursor];
      cursor += 1;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => worker()));
}

/** Card ids the live re-check covers: cart then saved rows, at most 80. */
export function liveCardIds(items, saved) {
  return [...new Set(
    [...(items || []), ...(saved || [])].map((row) => String(row.cardId || '')).filter(Boolean),
  )].slice(0, 80);
}

/** One card's live book as a re-check entry, or null when the request failed. */
export async function fetchLiveEntry(id) {
  let data = null;
  try {
    data = await fetchListings(id, { limit: LIVE_LIMIT, fresh: true });
  } catch (_) {
    data = null;
  }
  if (!data) return null;
  const listings = Array.isArray(data.listings) ? data.listings : [];
  return { listings, complete: listings.length < LIVE_LIMIT, at: Date.now() };
}

/** New notes replace older notes with the same id. */
export function mergeLiveNotes(current, notes) {
  return [
    ...current.filter((note) => !notes.some((next) => next.id === note.id)),
    ...notes,
  ];
}

function named(card) {
  return Boolean(card && String(card.name || '').trim());
}

export function tileIds(ids) {
  return (ids || []).map(String).filter(Boolean).slice(0, 24);
}

/**
 * Catalogue tiles for card ids, in that order. The tile API only knows part
 * of the catalogue, so a miss falls back to this browser's recent-tile cache
 * and then to `fallback` rows ({ id, name, canonicalPath }) — a name is
 * enough for CardArt to find the catalogue scan.
 */
export function orderCardTiles(wanted, cards, fallback) {
  const byId = new Map((cards || []).map((card) => [String(card.id), card]));
  const spare = new Map((fallback || []).map((card) => [String(card.id), card]));
  const ordered = wanted
    .map((id) => [byId.get(id), peekRecentTile(id), spare.get(id)].find(named))
    .filter(Boolean);
  // Ids the tile endpoint rewrote (provisional → public) still show up.
  const extra = (cards || []).filter((card) => named(card) && !wanted.includes(String(card.id)));
  return [...ordered, ...extra];
}

/** fetchCardTiles that never rejects (an empty list on failure). */
export function fetchTilesSafe(wanted) {
  return fetchCardTiles(wanted).then((cards) => cards, () => []);
}

/** Cards from the signed-in buyer's paid orders, newest first. */
export async function fetchBuyAgain(uid) {
  const { loadFirestore } = await import('./firebase-client.js');
  const { firestore, collection, getDocs, query, where } = await loadFirestore();
  const snap = await getDocs(query(collection(firestore, 'orders'), where('uid', '==', uid)));
  return buyAgainCards(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
}

/**
 * Other listings from the sellers already in the cart — the cards that ride
 * in a parcel you are paying shipping for anyway. Biggest parcels first.
 */
export function shelfSellers(groups, max = 2) {
  const out = [];
  const seen = new Set();
  const ranked = [...(groups || [])].sort((a, b) => b.subtotalPkn - a.subtotalPkn);
  for (const group of ranked) {
    const handle = sellerHandle({
      sellerUsername: group.sellerUsername,
      sellerName: group.sellerName,
    });
    const lower = handle.toLowerCase();
    if (!handle || seen.has(lower)) continue;
    seen.add(lower);
    out.push({ key: group.key, handle, sellerUid: group.sellerUid });
    if (out.length >= max) break;
  }
  return out;
}

/** One seller's shelf listings ([] when the shop could not be read). */
export function fetchShelfListings(handle, perSeller = 24) {
  return fetchSellerByUsername(handle, { limit: perSeller })
    .then((data) => (Array.isArray(data?.listings) ? data.listings : []), () => []);
}

/** The last two Pokémon names looked at, for "Inspired by your browsing history". */
export function inspiredNames(cards) {
  const out = [];
  for (const card of cards || []) {
    const name = String(card?.name || '').trim();
    if (name && !out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= 2) break;
  }
  return out;
}

/** Other printings of those names, interleaved. */
export async function fetchInspired(names, perName = 12) {
  const lists = await Promise.all(names.map((name) => fetchSpeciesCards(name, { limit: perName }).catch(() => [])));
  const seen = new Set();
  const merged = [];
  for (let at = 0; at < perName; at += 1) {
    for (const list of lists) {
      const card = list[at];
      const id = String(card?.id || card?.card_id || '');
      if (!id || seen.has(id) || !named(card)) continue;
      seen.add(id);
      merged.push(card);
    }
  }
  return merged;
}

/** Drop what the buyer already saw or carries. */
export function withoutIds(cards, exclude) {
  const skip = new Set((exclude || []).map(String));
  return (cards || []).filter((card) => !skip.has(String(card.id)));
}

/**
 * Inputs for GET /api/marketplace-recommendations and the key that decides
 * when to ask again (cart cards, ticked sellers, recent, watchlist, sign-in).
 */
export function recommendationInputs({ items, recentIds, watchIds, signedIn }) {
  const cart = [...new Set((items || []).map((row) => String(row.cardId || '')).filter(Boolean))];
  const sellers = [...new Set((items || [])
    .filter(isSelected)
    .map((row) => String(row.sellerUid || ''))
    .filter(Boolean))];
  const listings = (items || []).map((row) => String(row.listingId || '')).filter(Boolean);
  const key = [cart.join(','), sellers.join(','), (recentIds || []).slice(0, 24).join(','), (watchIds || []).slice(0, 24).join(','), signedIn ? 'in' : 'out'].join('|');
  return { cart, sellers, listings, recentIds, watchIds, key };
}

/** Recommendation rails are asked for after cart edits settle (qty taps, ticks). */
export const RECOMMENDATIONS_DEBOUNCE_MS = 350;
