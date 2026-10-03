'use strict';

/**
 * Personal card recommendations for the cart page (and any client): pure
 * ranking over the "buyable pool" — every card with an active native
 * listing — scored against what this buyer carries, bought, watches and
 * viewed. No I/O here; marketplace-recommendations.js feeds it.
 *
 * Signals weigh cart > bought > watchlist > recently viewed, and earlier
 * entries of each list (most recent) weigh more. A card scores on the same
 * artwork (CLIP version), same Pokédex species, same name, same artist and
 * same set; popularity (marketplace_hot_blueprints) only breaks ties, and
 * leads only the Trending rail.
 */

const SIGNAL_WEIGHT = { cart: 3, bought: 2.5, watch: 2, recent: 1.5 };
const MATCH_WEIGHT = { version: 2.5, species: 4, name: 3, artist: 2, set: 0.75 };
const DEFAULT_LIMIT = 18;

function text(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function key(value) {
  return text(value).toLowerCase();
}

function cardIdOf(card) {
  return text(card?.card_id ?? card?.cardId ?? card?.id, 24);
}

function species(card) {
  const n = Math.trunc(Number(card?.pokedex_num));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function artistOf(card) {
  return text(card?.artist || card?.illustrator, 120);
}

/** Comma list → unique numeric ids, in order. */
function parseIds(value, max = 24) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  const seen = new Set();
  for (const part of list) {
    const id = text(part, 24);
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function addWeight(map, k, weight, label) {
  if (!k) return;
  const current = map.get(k);
  if (current) {
    current.weight += weight;
  } else {
    map.set(k, { weight, label: label || String(k) });
  }
}

/**
 * Affinity from signal cards. `signals` is [{ card, source }] in priority
 * order inside each source; the n-th card of a source weighs 1/(1+n/6).
 */
function buildAffinity(signals = []) {
  const affinity = {
    versions: new Map(),
    species: new Map(),
    names: new Map(),
    artists: new Map(),
    sets: new Map(),
    size: 0,
  };
  const position = {};
  for (const { card, source } of signals) {
    if (!card) continue;
    const at = position[source] || 0;
    position[source] = at + 1;
    const weight = (SIGNAL_WEIGHT[source] || 1) / (1 + at / 6);
    const name = text(card.name);
    addWeight(affinity.versions, text(card.version, 40), weight, name);
    addWeight(affinity.species, species(card), weight, name.replace(/\s+(ex|EX|GX|V|VMAX|VSTAR|BREAK|LEGEND|Prime|LV\.X)\b.*$/, '') || name);
    addWeight(affinity.names, key(name), weight, name);
    addWeight(affinity.artists, key(artistOf(card)), weight, artistOf(card));
    addWeight(affinity.sets, key(card.set_name || card.setName), weight, text(card.set_name || card.setName));
    affinity.size += 1;
  }
  return affinity;
}

/** { score, reason, matches } of one card against an affinity. */
function affinityScore(card, affinity) {
  const hits = [];
  const consider = (kind, entry, factor, reason) => {
    if (!entry) return;
    hits.push({ kind, value: entry.weight * factor, reason });
  };
  const version = affinity.versions.get(text(card.version, 40));
  consider('version', version, MATCH_WEIGHT.version, 'Same artwork as a card you looked at');
  const kind = affinity.species.get(species(card));
  consider('species', kind, MATCH_WEIGHT.species, kind ? `More ${kind.label}` : '');
  const name = affinity.names.get(key(card.name));
  consider('name', name, MATCH_WEIGHT.name, name ? `Other printings of ${name.label}` : '');
  const artist = affinity.artists.get(key(artistOf(card)));
  consider('artist', artist, MATCH_WEIGHT.artist, artist ? `Art by ${artist.label}` : '');
  const set = affinity.sets.get(key(card.set_name));
  consider('set', set, MATCH_WEIGHT.set, set ? `From ${set.label}` : '');
  if (!hits.length) return { score: 0, reason: '', matches: [] };
  hits.sort((a, b) => b.value - a.value);
  return {
    score: hits.reduce((sum, hit) => sum + hit.value, 0),
    reason: hits[0].reason,
    matches: hits.map((hit) => hit.kind),
  };
}

function hotOf(card, window = '7d') {
  const n = Number(window === '24h' ? card?.hot_24h : card?.hot_7d);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Popularity as a 0..1 tie-breaker against the pool's hottest card. */
function popularity(card, maxHot) {
  if (!(maxHot > 0)) return 0;
  return Math.log1p(hotOf(card)) / Math.log1p(maxHot);
}

function maxHotOf(pool) {
  let max = 0;
  for (const card of pool) max = Math.max(max, hotOf(card));
  return max;
}

/**
 * Rank pool cards for one rail. `want(match)` picks which affinity matches
 * qualify; `exclude` is a Set of card ids already seen or used.
 */
function rankByAffinity(pool, affinity, { want, exclude, limit = DEFAULT_LIMIT, maxHot = maxHotOf(pool) }) {
  const scored = [];
  for (const card of pool) {
    const id = cardIdOf(card);
    if (!id || exclude.has(id)) continue;
    const result = affinityScore(card, affinity);
    if (!(result.score > 0) || !want(result.matches)) continue;
    scored.push({ card, score: result.score + 0.5 * popularity(card, maxHot), reason: result.reason });
  }
  scored.sort((a, b) => b.score - a.score || Number(a.card.min_price) - Number(b.card.min_price));
  return scored.slice(0, limit);
}

/** Trending: hottest today (then this week), nudged toward this buyer's taste. */
function rankTrending(pool, affinity, { exclude, limit = DEFAULT_LIMIT }) {
  const max24 = pool.reduce((max, card) => Math.max(max, hotOf(card, '24h')), 0);
  const max7 = maxHotOf(pool);
  const scored = [];
  for (const card of pool) {
    const id = cardIdOf(card);
    if (!id || exclude.has(id)) continue;
    const heat = (max24 > 0 ? Math.log1p(hotOf(card, '24h')) / Math.log1p(max24) : 0)
      + 0.5 * (max7 > 0 ? Math.log1p(hotOf(card)) / Math.log1p(max7) : 0);
    if (!(heat > 0)) continue;
    const taste = affinity.size ? affinityScore(card, affinity) : { score: 0, reason: '' };
    // Popularity leads here; taste only reorders cards that are similarly hot.
    scored.push({
      card,
      score: heat + Math.min(0.3, taste.score / 40),
      reason: taste.score > 0 ? `Trending · ${taste.reason}` : 'Trending on Pokoin',
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** "Customers who carried these also carried": co-cart counts, then heat. */
function rankCoCarted(poolById, counts, { exclude, limit = DEFAULT_LIMIT }) {
  const scored = [];
  for (const [id, n] of counts) {
    if (exclude.has(id)) continue;
    const card = poolById.get(id);
    if (!card) continue;
    scored.push({
      card,
      score: n + popularity(card, hotOf(card) + 1),
      reason: n > 1 ? `In ${n} other carts with yours` : 'In another cart with yours',
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** A seller's other listings, best match for this buyer first, then cheapest. */
function rankSellerShelf(listings, poolById, affinity, { excludeListings, excludeCards, limit = DEFAULT_LIMIT }) {
  const scored = [];
  const seenCards = new Set();
  for (const offer of listings) {
    const listingId = text(offer.id, 80);
    const id = text(offer.card_id, 24);
    if (!listingId || excludeListings.has(listingId) || excludeCards.has(id) || seenCards.has(id)) continue;
    const card = poolById.get(id);
    if (!card) continue;
    seenCards.add(id);
    const taste = affinityScore(card, affinity);
    scored.push({
      card,
      offer,
      score: taste.score,
      price: Number(offer.price_pkn) || 0,
      reason: taste.reason || 'Ships in the same parcel',
    });
  }
  scored.sort((a, b) => b.score - a.score || a.price - b.price);
  return scored.slice(0, limit);
}

// --- offer choice (same cascade as the SPA's pickCartOffer) ----------------

const CONDITION_RANK = { nm: 0, ex: 1, sp: 2, mp: 3, pl: 4, poor: 5 };

function conditionTone(condition) {
  const value = key(condition).replace(/[^a-z0-9 ]+/g, ' ').trim();
  if (!value) return 'nm';
  if (/^(nm|near mint|mint|m)\b/.test(value)) return 'nm';
  if (/^(ex|excellent)\b/.test(value)) return 'ex';
  if (/^(sp|lp|slightly played|lightly played|good|gd)\b/.test(value)) return 'sp';
  if (/^(mp|moderately played)\b/.test(value)) return 'mp';
  if (/^(pl|hp|played|heavily played)\b/.test(value)) return 'pl';
  if (/^(po|poor|damaged|dmg)\b/.test(value)) return 'poor';
  return '';
}

function isEnglish(offer) {
  const lang = key(offer.language);
  return lang === 'en' || lang === 'eng' || lang === 'english';
}

/** English Near Mint, then other English, then Near Mint elsewhere, then the rest. Never graded. */
function pickOffer(offers = []) {
  const rows = offers.filter((offer) => !offer.graded && Number(offer.price_pkn) > 0 && Number(offer.quantity_available) > 0);
  const price = (offer) => Number(offer.price_pkn);
  const rank = (offer) => {
    const tone = conditionTone(offer.condition);
    return Object.prototype.hasOwnProperty.call(CONDITION_RANK, tone) ? CONDITION_RANK[tone] : 6;
  };
  const cheapest = (list) => list.slice().sort((a, b) => price(a) - price(b))[0] || null;
  const best = (list) => list.slice().sort((a, b) => rank(a) - rank(b) || price(a) - price(b))[0] || null;
  const home = rows.filter(isEnglish);
  const other = rows.filter((offer) => !isEnglish(offer));
  return cheapest(home.filter((offer) => rank(offer) === 0))
    || best(home.filter((offer) => rank(offer) !== 0))
    || cheapest(other.filter((offer) => rank(offer) === 0))
    || best(other.filter((offer) => rank(offer) !== 0))
    || null;
}

/** Bought card ids from orders that were paid, newest first, once each. */
function boughtCardIds(orders = [], max = 24) {
  const paid = new Set(['paid', 'escrow', 'released', 'partially_refunded']);
  const stamp = (value) => {
    if (!value) return 0;
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  };
  const sorted = orders
    .filter((order) => paid.has(String(order?.paymentStatus || '')))
    .sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt));
  const out = [];
  const seen = new Set();
  for (const order of sorted) {
    for (const item of Array.isArray(order.items) ? order.items : []) {
      const id = text(item?.card?.id ?? item?.cardId, 24);
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ cardId: id, purchasedAt: stamp(order.createdAt) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Labels for a rail subtitle: the strongest few entries of an affinity map. */
function topLabels(map, n = 2) {
  return [...map.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((entry) => entry.label)
    .filter(Boolean);
}

function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

module.exports = {
  DEFAULT_LIMIT,
  MATCH_WEIGHT,
  SIGNAL_WEIGHT,
  affinityScore,
  boughtCardIds,
  buildAffinity,
  cardIdOf,
  conditionTone,
  joinLabels,
  parseIds,
  pickOffer,
  rankByAffinity,
  rankCoCarted,
  rankSellerShelf,
  rankTrending,
  topLabels,
};
