// Pokoin Flex savings from the real carrier table (shipping-rates.json, the
// same rates checkout quotes). "Alone" is the service the seller picks for
// that route and pack size (tracked or untracked letter). "Flex" is a weight
// share of one ~20 kg bag sent as one parcel on the same route (EXTRA_LARGE
// tier), plus — for home delivery — the same kind of service inside the
// destination country.

import ratesCatalog from './shipping-rates.json' with { type: 'json' };
import { findShippingRate, packageTierForCount } from './shipping-quote.js';

/** Every number here is shown on /flex so the estimate can be checked. */
export const FLEX_ASSUMPTIONS = Object.freeze({
  bagGrams: 20000,
  defaultBagFill: 0.6,
  boxGrams: 45,
  gramsPerCard: 2,
  boxCents: 60,
  handlingCents: 50,
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

/**
 * Alone vs Flex for one pack. `tracked` picks the service the seller would
 * use alone (and, for home delivery, inside the destination country).
 * `delivery` is 'pickup' (partner shop, no last mile) or 'home'.
 * Returns null when a price is missing.
 */
export function flexQuote({
  from,
  to,
  cards,
  tracked = true,
  delivery = 'pickup',
  bagFill = FLEX_ASSUMPTIONS.defaultBagFill,
  assumptions = FLEX_ASSUMPTIONS,
  catalog = ratesCatalog,
} = {}) {
  const fromCode = String(from || '').toUpperCase();
  const toCode = String(to || '').toUpperCase();
  const count = Math.max(1, Math.trunc(Number(cards) || 0));
  const tier = packageTierForCount(count);
  const services = routeServices({ from: fromCode, to: toCode, cards: count, catalog });
  const alone = pickService(services, tracked !== false);
  const trunk = trunkLeg(fromCode, toCode, catalog);
  if (!alone || !trunk) return null;

  const fill = Math.min(1, Math.max(0.1, Number(bagFill) || assumptions.defaultBagFill));
  const grams = packGrams(count, assumptions);
  const filledGrams = assumptions.bagGrams * fill;
  let lastMile = null;
  if (delivery === 'home') {
    lastMile = pickService(routeServices({ from: toCode, to: toCode, cards: count, catalog }), alone.tracked);
    if (!lastMile) return null;
  }
  const parts = {
    box: assumptions.boxCents,
    handling: assumptions.handlingCents,
    trunk: Math.round((trunk.cents * grams) / filledGrams),
    lastMile: lastMile ? lastMile.cents : 0,
  };
  const flex = parts.box + parts.handling + parts.trunk + parts.lastMile;
  const saved = alone.cents - flex;
  return {
    from: fromCode,
    to: toCode,
    cards: count,
    tier,
    delivery,
    bagFill: fill,
    services,
    alone,
    flex: { cents: flex, parts },
    savedCents: saved,
    savedPct: alone.cents > 0 ? Math.round((saved / alone.cents) * 100) : 0,
    packGrams: grams,
    packsPerBag: Math.floor(filledGrams / grams),
    trunk,
    lastMile,
  };
}

/** Every lane × a few pack sizes, for the table under the calculator. */
export function flexLaneTable({ sizes = [4, 20, 50], ...options } = {}) {
  return flexLanes(options.catalog).map((lane) => ({
    ...lane,
    quotes: sizes.map((cards) => flexQuote({ ...options, from: lane.from, to: lane.to, cards })),
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
