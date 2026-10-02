// Pokoin Flex savings from the real carrier table (shipping-rates.json, the
// same rates checkout quotes). "Alone" is N sellers each posting their own
// pack. Flex is two shipments, each split by the packets actually inside:
//   1. Sellers drop at a partner; the partner ships one pack on the route.
//   2. The magazine ships one pack to a city pickup (or one home parcel).
// One seller is one direct-sized pack plus the Flex box, handling, and the
// second hop — never a gram-slice of a half-empty 20 kg bag.

import ratesCatalog from './shipping-rates.json' with { type: 'json' };
import { findShippingRate, packageTierForCount } from './shipping-quote.js';

/** Every number here is shown on /flex so the estimate can be checked. */
export const FLEX_ASSUMPTIONS = Object.freeze({
  bagGrams: 20000,
  boxGrams: 45,
  gramsPerCard: 2,
  boxCents: 60,
  handlingCents: 50,
  maxSellers: 8,
  /** Buyer packets in the magazine → city partner pack (the second hop). */
  defaultPickupPackets: 12,
  maxPickupPackets: 40,
  /** Heavier than this, the hop is the ~20 kg bag. Lighter packs use the normal parcel rate. */
  parcelMaxGrams: 10000,
});

const TRUNK_TIER = 'EXTRA_LARGE';

function cents(rate) {
  return rate ? Number(rate.priceEURCents) || 0 : null;
}

/**
 * Every live service for one route and pack size, cheapest first:
 * [{ id, tracked, carrier, service, cents }]. What checkout would offer.
 */
export function routeServices({ from, to, cards, catalog = ratesCatalog } = {}) {
  const fromCode = String(from || '').toUpperCase();
  const toCode = String(to || '').toUpperCase();
  const tier = packageTierForCount(Math.max(1, Math.trunc(Number(cards) || 0)));
  return (catalog.rates || [])
    .filter((rate) => rate.active !== false
      && String(rate.fromCountry).toUpperCase() === fromCode
      && String(rate.toCountry).toUpperCase() === toCode
      && String(rate.packageTier).toUpperCase() === tier)
    .map((rate) => ({
      id: rate.id,
      tracked: rate.tracked !== false,
      carrier: rate.carrier || '',
      service: rate.serviceName || '',
      cents: cents(rate),
    }))
    .sort((a, b) => a.cents - b.cents);
}

/** Cheapest service with the wanted tracking, else the cheapest at all. */
function pickService(services, tracked) {
  return services.find((row) => row.tracked === tracked) || services[0] || null;
}

/** Countries with at least one live rate, sender side and receiver side. */
export function flexCountries(catalog = ratesCatalog) {
  const from = new Set();
  const to = new Set();
  for (const rate of catalog.rates || []) {
    if (rate.active === false) continue;
    from.add(String(rate.fromCountry).toUpperCase());
    to.add(String(rate.toCountry).toUpperCase());
  }
  return { from: [...from].sort(), to: [...to].sort() };
}

/** Lanes a seller can ship alone today (tracked rate exists). */
export function flexLanes(catalog = ratesCatalog) {
  const seen = new Set();
  const lanes = [];
  for (const rate of catalog.rates || []) {
    if (rate.active === false || rate.tracked === false) continue;
    const from = String(rate.fromCountry).toUpperCase();
    const to = String(rate.toCountry).toUpperCase();
    const key = `${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lanes.push({ from, to });
  }
  return lanes.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * The bag as one parcel on the route (carrier parcel rate). A lane missing
 * from the table borrows its reverse direction and is flagged as an estimate.
 */
export function trunkLeg(from, to, catalog = ratesCatalog) {
  const direct = findShippingRate({ fromCountry: from, toCountry: to, packageTier: TRUNK_TIER, catalog });
  if (direct) return { cents: cents(direct), carrier: direct.carrier, estimated: false };
  const reverse = findShippingRate({ fromCountry: to, toCountry: from, packageTier: TRUNK_TIER, catalog });
  if (reverse) return { cents: cents(reverse), carrier: reverse.carrier, estimated: true };
  return null;
}

export function packGrams(cardCount, assumptions = FLEX_ASSUMPTIONS) {
  const n = Math.max(1, Math.trunc(Number(cardCount) || 0));
  return assumptions.boxGrams + n * assumptions.gramsPerCard;
}

/** Cards each of N sellers ships when the cart has `cards` total. */
export function perSellerCards(cards, sellers) {
  const n = Math.min(
    FLEX_ASSUMPTIONS.maxSellers,
    Math.max(1, Math.trunc(Number(sellers) || 1)),
  );
  const c = Math.max(1, Math.trunc(Number(cards) || 0));
  return Math.ceil(c / n);
}

/**
 * Card-count proxy for a single home parcel. EXTRA_LARGE is the ~20 kg bag
 * only — a buyer's own cards stay on the letter/parcel tier.
 */
export function lastMileCardCount(grams) {
  const g = Math.max(1, Number(grams) || 1);
  if (g <= 100) return 4; // SMALL
  if (g <= 250) return 20; // MEDIUM
  return 50; // LARGE — still a letter/small parcel, not the bag
}

/**
 * One carrier shipment that holds `packets` Flex boxes of `cardsPerPacket`
 * cards. Weight picks the letter/parcel tier. The ~20 kg bag rate starts
 * once the pack passes `parcelMaxGrams`, and another bag for each extra 20 kg.
 */
export function consolidatedLeg({
  from,
  to,
  packets,
  cardsPerPacket,
  tracked = true,
  assumptions = FLEX_ASSUMPTIONS,
  catalog = ratesCatalog,
} = {}) {
  const fromCode = String(from || '').toUpperCase();
  const toCode = String(to || '').toUpperCase();
  const count = Math.max(1, Math.trunc(Number(packets) || 1));
  const cardsEach = Math.max(1, Math.trunc(Number(cardsPerPacket) || 1));
  const gramsEach = packGrams(cardsEach, assumptions);
  const totalGrams = gramsEach * count;
  const totalCards = cardsEach * count;
  const usingBag = totalGrams > assumptions.parcelMaxGrams;
  const quoteCards = usingBag
    ? Math.max(totalCards, (catalog.tiers || []).find((tier) => tier.id === 'EXTRA_LARGE')?.maxCards || 9999)
    : lastMileCardCount(totalGrams);
  const services = routeServices({
    from: fromCode,
    to: toCode,
    cards: quoteCards,
    catalog,
  });
  const picked = pickService(services, tracked !== false);
  if (!picked) return null;
  let carrier = picked.carrier;
  let service = picked.service;
  let cents = picked.cents;
  let estimated = false;
  let bags = 1;
  if (usingBag) {
    bags = Math.max(1, Math.ceil(totalGrams / assumptions.bagGrams));
    const trunk = trunkLeg(fromCode, toCode, catalog);
    if (!trunk) return null;
    cents = trunk.cents * bags;
    carrier = trunk.carrier;
    service = bags > 1 ? `${bags} × ${trunk.carrier} parcel` : (picked.service || 'Parcel');
    estimated = trunk.estimated;
  }
  return {
    cents,
    carrier,
    service,
    tracked: picked.tracked,
    estimated,
    packets: count,
    totalCards,
    totalGrams,
    tier: usingBag ? 'EXTRA_LARGE' : packageTierForCount(quoteCards),
    bags,
  };
}

/**
 * Alone vs Flex for `sellers` packs on one route.
 * `tracked` picks the service each seller would use alone (and each Flex hop).
 * `delivery` is 'pickup' (city partner pack) or 'home' (one warehouse parcel).
 * `pickupPackets` is how many buyer packets share the magazine → city pack.
 * Returns null when a price is missing.
 */
export function flexQuote({
  from,
  to,
  cards,
  sellers = 1,
  tracked = true,
  delivery = 'pickup',
  pickupPackets,
  assumptions = FLEX_ASSUMPTIONS,
  catalog = ratesCatalog,
} = {}) {
  const fromCode = String(from || '').toUpperCase();
  const toCode = String(to || '').toUpperCase();
  const count = Math.max(1, Math.trunc(Number(cards) || 0));
  const sellerCount = Math.min(
    assumptions.maxSellers || FLEX_ASSUMPTIONS.maxSellers,
    Math.max(1, Math.trunc(Number(sellers) || 1)),
  );
  const perSeller = perSellerCards(count, sellerCount);
  const tier = packageTierForCount(perSeller);
  const services = routeServices({ from: fromCode, to: toCode, cards: perSeller, catalog });
  const aloneOne = pickService(services, tracked !== false);
  if (!aloneOne) return null;

  const gramsOne = packGrams(perSeller, assumptions);
  const totalGrams = gramsOne * sellerCount;
  // Phase 1: the partner ships one pack containing this order's seller packets.
  // One seller → that pack is the same size as posting it yourself.
  const intake = consolidatedLeg({
    from: fromCode,
    to: toCode,
    packets: sellerCount,
    cardsPerPacket: perSeller,
    tracked: aloneOne.tracked,
    assumptions,
    catalog,
  });
  if (!intake) return null;

  const maxPickup = assumptions.maxPickupPackets || FLEX_ASSUMPTIONS.maxPickupPackets;
  const requestedPickup = Math.trunc(Number(pickupPackets));
  const cityPackets = Math.min(
    maxPickup,
    Math.max(sellerCount, requestedPickup > 0 ? requestedPickup : sellerCount),
  );

  let city = null;
  let lastMile = null;
  if (delivery === 'home') {
    // One parcel to this buyer. Sized to their cards, never the 20 kg bag,
    // and never once per seller.
    lastMile = pickService(
      routeServices({
        from: toCode,
        to: toCode,
        cards: lastMileCardCount(totalGrams),
        catalog,
      }),
      aloneOne.tracked,
    );
    if (!lastMile) return null;
  } else {
    city = consolidatedLeg({
      from: toCode,
      to: toCode,
      packets: cityPackets,
      cardsPerPacket: perSeller,
      tracked: aloneOne.tracked,
      assumptions,
      catalog,
    });
    if (!city) return null;
  }

  const cityShare = city ? Math.round((city.cents * sellerCount) / cityPackets) : 0;
  const parts = {
    box: assumptions.boxCents * sellerCount,
    handling: assumptions.handlingCents * sellerCount,
    trunk: intake.cents,
    lastMile: lastMile ? lastMile.cents : cityShare,
  };
  const flex = parts.box + parts.handling + parts.trunk + parts.lastMile;
  const aloneCents = aloneOne.cents * sellerCount;
  const alone = {
    ...aloneOne,
    cents: aloneCents,
    perSellerCents: aloneOne.cents,
    sellers: sellerCount,
  };
  const saved = aloneCents - flex;
  return {
    from: fromCode,
    to: toCode,
    cards: count,
    sellers: sellerCount,
    perSellerCards: perSeller,
    tier,
    delivery,
    pickupPackets: delivery === 'home' ? null : cityPackets,
    services,
    alone,
    flex: { cents: flex, parts },
    savedCents: saved,
    savedPct: aloneCents > 0 ? Math.round((saved / aloneCents) * 100) : 0,
    packGrams: gramsOne,
    totalGrams,
    packsPerBag: Math.floor(assumptions.bagGrams / gramsOne),
    trunk: intake,
    intake,
    city,
    lastMile,
  };
}

/** Every lane × a few pack sizes, for the table under the calculator. */
export function flexLaneTable({
  sizes = [4, 20, 50],
  sellers = 3,
  pickupPackets = FLEX_ASSUMPTIONS.defaultPickupPackets,
  ...options
} = {}) {
  return flexLanes(options.catalog).map((lane) => ({
    ...lane,
    quotes: sizes.map((cards) => flexQuote({
      ...options,
      from: lane.from,
      to: lane.to,
      cards,
      sellers,
      pickupPackets,
      delivery: 'pickup',
    })),
  }));
}

/** Average saving across lanes and sizes that have both prices. */
export function flexAverageSaving(options = {}) {
  const quotes = flexLaneTable(options).flatMap((row) => row.quotes).filter(Boolean);
  if (!quotes.length) return null;
  const alone = quotes.reduce((sum, row) => sum + row.alone.cents, 0);
  const flex = quotes.reduce((sum, row) => sum + row.flex.cents, 0);
  return {
    quotes: quotes.length,
    aloneCents: alone,
    flexCents: flex,
    savedPct: Math.round(((alone - flex) / alone) * 100),
  };
}

export function formatEur(centsValue) {
  const n = Number(centsValue) || 0;
  const sign = n < 0 ? '−' : '';
  return `${sign}€${(Math.abs(n) / 100).toFixed(2)}`;
}
