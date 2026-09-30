'use strict';

const DEFAULT_RATES = require('./shipping-rates.json');

const ISO2 = /^[A-Z]{2}$/;

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || 'checkout_error';
  return error;
}

function normalizeCountry(value) {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'EU' || code === 'EUROPE') {
    return '';
  }
  return ISO2.test(code) ? code : '';
}

function assertShipFromCountry(value) {
  const code = normalizeCountry(value);
  if (!code) {
    throw httpError(400, 'shipFromCountry must be a real ISO 3166-1 alpha-2 code (not EU).', 'invalid_ship_from');
  }
  return code;
}

function cardCount(items = []) {
  return (items || []).reduce((sum, row) => {
    const qty = Number(row.quantity ?? row.qty ?? 0);
    return sum + (Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 0);
  }, 0);
}

function packageTierForCount(count, catalog = DEFAULT_RATES) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n < 1) {
    throw httpError(400, 'Shipment needs at least one card.', 'empty_shipment');
  }
  const tiers = [...(catalog.tiers || [])].sort((a, b) => a.maxCards - b.maxCards);
  const match = tiers.find((tier) => n <= Number(tier.maxCards));
  if (!match) {
    throw httpError(400, 'No package tier covers this card count.', 'package_tier_missing');
  }
  return match.id;
}

function groupCartBySeller(items = []) {
  const bySeller = new Map();
  for (const row of items || []) {
    const sellerId = String(row.sellerUid || row.sellerId || row.seller_uid || '').trim();
    if (!sellerId) {
      throw httpError(400, 'Every cart row needs a sellerUid.', 'missing_seller');
    }
    const list = bySeller.get(sellerId) || [];
    list.push(row);
    bySeller.set(sellerId, list);
  }
  return [...bySeller.entries()].map(([sellerId, sellerItems]) => ({
    sellerId,
    sellerName: String(sellerItems[0]?.sellerName || sellerItems[0]?.seller || '').trim(),
    items: sellerItems,
    cardCount: cardCount(sellerItems),
  }));
}

function findRate({ fromCountry, toCountry, packageTier, tracked = true, catalog = DEFAULT_RATES }) {
  const from = assertShipFromCountry(fromCountry);
  const to = assertShipFromCountry(toCountry);
  const tier = String(packageTier || '').trim().toUpperCase();
  const wantTracked = tracked !== false;
  const matches = (catalog.rates || []).filter((rate) => (
    rate.active !== false
    && String(rate.fromCountry).toUpperCase() === from
    && String(rate.toCountry).toUpperCase() === to
    && String(rate.packageTier).toUpperCase() === tier
  ));
  const row = matches.find((rate) => Boolean(rate.tracked !== false) === wantTracked)
    || matches.find((rate) => wantTracked) // fall back to any tracked
    || matches[0];
  if (!row) {
    const error = httpError(
      409,
      'Shipping is not currently available for this route.',
      'shipping_rate_missing',
    );
    error.meta = { fromCountry: from, toCountry: to, packageTier: tier, tracked: wantTracked };
    throw error;
  }
  return row;
}

function quoteShipment({
  sellerId,
  fromCountry,
  toCountry,
  items,
  tracked = true,
  catalog = DEFAULT_RATES,
} = {}) {
  const count = cardCount(items);
  const packageTier = packageTierForCount(count, catalog);
  const rate = findRate({ fromCountry, toCountry, packageTier, tracked, catalog });
  return {
    sellerId: String(sellerId || '').trim(),
    rateId: rate.id,
    fromCountry: String(rate.fromCountry).toUpperCase(),
    toCountry: String(rate.toCountry).toUpperCase(),
    cardCount: count,
    packageTier,
    tracked: rate.tracked !== false,
    estimatedWeightGrams: count * 2,
    carrier: rate.carrier || '',
    serviceName: rate.serviceName || 'Standard',
    amountCents: Number(rate.priceEURCents) || 0,
    currency: 'EUR',
  };
}

/** 1 PKN = 0.005 EUR → EUR cents from PKN. */
function eurCentsFromPkn(pkn) {
  const amount = Number(pkn);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 0.005 * 100);
}

function itemsSubtotalCents(items = []) {
  return (items || []).reduce((sum, row) => {
    const qty = Math.max(0, Math.trunc(Number(row.quantity ?? row.qty) || 0));
    if (row.unitPriceEURCents != null || row.totalPriceEURCents != null) {
      const line = row.totalPriceEURCents != null
        ? Number(row.totalPriceEURCents)
        : Number(row.unitPriceEURCents) * qty;
      return sum + (Number.isFinite(line) ? Math.round(line) : 0);
    }
    const unitPkn = Number(row.unitPricePkn ?? row.pricePkn) || 0;
    return sum + eurCentsFromPkn(unitPkn * qty);
  }, 0);
}

function quoteCheckout({
  items,
  sellerOrigins = {},
  toCountry,
  tracked = true,
  catalog = DEFAULT_RATES,
} = {}) {
  const groups = groupCartBySeller(items);
  const shipments = groups.map((group) => {
    const fromCountry = sellerOrigins[group.sellerId] || group.items[0]?.shipFromCountry || group.items[0]?.sellerCountry;
    const quote = quoteShipment({
      sellerId: group.sellerId,
      fromCountry,
      toCountry,
      items: group.items,
      tracked,
      catalog,
    });
    const itemsCents = itemsSubtotalCents(group.items);
    return {
      ...quote,
      sellerName: group.sellerName,
      itemsSubtotalCents: itemsCents,
      itemCount: group.cardCount,
    };
  });
  const itemsSubtotal = shipments.reduce((sum, row) => sum + row.itemsSubtotalCents, 0);
  const shippingTotal = shipments.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    shipments,
    itemsSubtotalCents: itemsSubtotal,
    shippingTotalCents: shippingTotal,
    grandTotalCents: itemsSubtotal + shippingTotal,
    currency: 'EUR',
    tracked: tracked !== false,
  };
}

function normalizeAddressInput(raw = {}) {
  return {
    fullName: String(raw.fullName || raw.name || '').trim().slice(0, 120),
    companyName: String(raw.companyName || '').trim().slice(0, 120),
    addressLine1: String(raw.addressLine1 || raw.line1 || '').trim().slice(0, 180),
    addressLine2: String(raw.addressLine2 || raw.line2 || '').trim().slice(0, 180),
    postalCode: String(raw.postalCode || raw.postal_code || '').trim().slice(0, 40),
    city: String(raw.city || '').trim().slice(0, 120),
    stateProvinceRegion: String(raw.stateProvinceRegion || raw.region || '').trim().slice(0, 120),
    countryCode: normalizeCountry(raw.countryCode || raw.country),
    phoneNumber: String(raw.phoneNumber || raw.phone || '').trim().slice(0, 80),
    deliveryInstructions: String(raw.deliveryInstructions || '').trim().slice(0, 240),
  };
}

function validateAddressFields(address) {
  const row = normalizeAddressInput(address);
  if (!row.fullName || !row.addressLine1 || !row.postalCode || !row.city || !row.countryCode) {
    throw httpError(
      400,
      'Address requires fullName, addressLine1, postalCode, city, and countryCode.',
      'invalid_address',
    );
  }
  return row;
}

module.exports = {
  DEFAULT_RATES,
  assertShipFromCountry,
  cardCount,
  findRate,
  groupCartBySeller,
  itemsSubtotalCents,
  normalizeAddressInput,
  normalizeCountry,
  packageTierForCount,
  quoteCheckout,
  quoteShipment,
  validateAddressFields,
  eurCentsFromPkn,
  httpError,
};
