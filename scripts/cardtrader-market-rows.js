// Shared CardTrader snapshot-row helpers. Daily job on Pi copies this next to
// `_cardtrader_daily_listings_refresh.js`. Expansion fetches still cap at 25;
// blueprint fetches pass limit 0 (full listing book).

const CARDTRADER_CHEAPEST_LISTING_LIMIT = 25;

function listingPriceCents(row = {}) {
  if (Number.isFinite(row.priceCents)) return row.priceCents;
  if (Number.isFinite(row.price)) return Math.round(row.price * 100);
  return Number.POSITIVE_INFINITY;
}

function takeListingRows(rows, limit = CARDTRADER_CHEAPEST_LISTING_LIMIT) {
  if (!limit || !Array.isArray(rows) || rows.length <= limit) return rows || [];
  return rows
    .slice()
    .sort((left, right) => {
      const priceDelta = listingPriceCents(left) - listingPriceCents(right);
      if (priceDelta !== 0) return priceDelta;
      return String(left.externalListingId || '').localeCompare(String(right.externalListingId || ''));
    })
    .slice(0, limit);
}

function listingPopulation(rows = [], blueprintId = null, cheapestListingLimit = CARDTRADER_CHEAPEST_LISTING_LIMIT) {
  const sellers = new Set();
  let listedQuantity = 0;
  let listingCount = 0;
  for (const row of rows) {
    listingCount += 1;
    listedQuantity += Math.max(0, Number(row.quantity) || 0);
    const seller = String(row.sellerAccountId || '').trim();
    if (seller) sellers.add(seller);
  }
  return {
    blueprintId: blueprintId == null ? null : blueprintId,
    listingCount,
    listedQuantity,
    sellerCount: sellers.size,
    capped: Boolean(cheapestListingLimit) && listingCount >= cheapestListingLimit,
  };
}

function appendListingRows(target, incoming, productLimit, cheapestListingLimit = CARDTRADER_CHEAPEST_LISTING_LIMIT) {
  let truncated = false;
  for (const row of takeListingRows(incoming, cheapestListingLimit)) {
    if (target.length >= productLimit) {
      truncated = true;
      break;
    }
    target.push(row);
  }
  return truncated;
}

function isTruthyProp(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function listingFacetFlags(properties = {}, product = {}) {
  const reverse = isTruthyProp(properties.pokemon_reverse)
    || String(properties.foil_state || properties.foilState || '').trim().toLowerCase() === 'reverse';
  const firstEdition = isTruthyProp(properties.first_edition)
    || isTruthyProp(properties.firstEdition)
    || isTruthyProp(properties.pokemon_first_edition);
  const graded = isTruthyProp(product.graded) || isTruthyProp(properties.graded);
  return { reverse, firstEdition, graded };
}

module.exports = {
  CARDTRADER_CHEAPEST_LISTING_LIMIT,
  appendListingRows,
  isTruthyProp,
  listingFacetFlags,
  listingPopulation,
  listingPriceCents,
  takeListingRows,
};
