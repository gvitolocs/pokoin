// Pokoin Flex savings from the real carrier table (shipping-rates.json).
// "Alone" is the tracked rate the seller pays today at checkout. "Flex" is a
// weight share of one ~20 kg bag, priced at the same carriers' parcel rate
// (EXTRA_LARGE tier) for the leg to the sorting center and the leg out.

import ratesCatalog from './shipping-rates.json' with { type: 'json' };
import { findShippingRate, packageTierForCount } from './shipping-quote.js';

/** Every number here is shown on /flex so the estimate can be checked. */
export const FLEX_ASSUMPTIONS = Object.freeze({
  hubCountry: 'DK',
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
 * One trunk leg priced at the carrier parcel rate. A lane missing from the
 * table borrows its reverse direction and is flagged as an estimate.
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
 * Alone vs Flex for one pack. `delivery` is 'pickup' (partner shop, no last
 * mile) or 'home' (tracked small parcel inside the destination country).
 * Returns null when either side has no price.
 */
export function flexQuote({
  from,
  to,
  cards,
  delivery = 'pickup',
  bagFill = FLEX_ASSUMPTIONS.defaultBagFill,
  assumptions = FLEX_ASSUMPTIONS,
  catalog = ratesCatalog,
} = {}) {
  const fromCode = String(from || '').toUpperCase();
  const toCode = String(to || '').toUpperCase();
  const count = Math.max(1, Math.trunc(Number(cards) || 0));
  const tier = packageTierForCount(count);
  const aloneRate = findShippingRate({ fromCountry: fromCode, toCountry: toCode, packageTier: tier, tracked: true, catalog });
  const alone = cents(aloneRate);
  const hub = assumptions.hubCountry;
  const inbound = trunkLeg(fromCode, hub, catalog);
  const outbound = trunkLeg(hub, toCode, catalog);
  if (alone == null || !inbound || !outbound) return null;

  const fill = Math.min(1, Math.max(0.1, Number(bagFill) || assumptions.defaultBagFill));
  const grams = packGrams(count, assumptions);
  const filledGrams = assumptions.bagGrams * fill;
  const trunkCents = inbound.cents + outbound.cents;
  const trunkShare = (trunkCents * grams) / filledGrams;
  let lastMile = 0;
  let lastMileRate = null;
  if (delivery === 'home') {
    lastMileRate = findShippingRate({ fromCountry: toCode, toCountry: toCode, packageTier: tier, tracked: true, catalog });
    if (!lastMileRate) return null;
    lastMile = cents(lastMileRate);
  }
  const parts = {
    box: assumptions.boxCents,
    handling: assumptions.handlingCents,
    trunk: Math.round(trunkShare),
    lastMile,
  };
  const flex = parts.box + parts.handling + parts.trunk + parts.lastMile;
  const saved = alone - flex;
  return {
    from: fromCode,
    to: toCode,
    cards: count,
    tier,
    delivery,
    bagFill: fill,
    alone: {
      cents: alone,
      carrier: aloneRate.carrier,
      service: aloneRate.serviceName,
    },
    flex: { cents: flex, parts },
    savedCents: saved,
    savedPct: alone > 0 ? Math.round((saved / alone) * 100) : 0,
    packGrams: grams,
    packsPerBag: Math.floor(filledGrams / grams),
    trunk: {
      cents: trunkCents,
      inbound,
      outbound,
      estimated: inbound.estimated || outbound.estimated,
    },
    lastMile: lastMileRate
      ? { cents: lastMile, carrier: lastMileRate.carrier, service: lastMileRate.serviceName }
      : null,
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
