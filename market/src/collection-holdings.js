/** Pure helpers for Portfolio / Collection owned counts. */

import { isLiveInventoryListing } from './inventory-listings.js';
import { inventoryMarketValue } from './inventory-price.js';

export function sumOwnedQuantity(rows = []) {
  let total = 0;
  for (const row of rows) {
    const qty = Number(row?.quantity);
    total += Number.isFinite(qty) && qty > 0 ? qty : 0;
  }
  return total;
}

export function isNftHolding(row = {}) {
  return row.ownershipType === 'nft'
    || row.fulfillmentMode === 'nft_only'
    || row.nftStatus === 'owned';
}

export function partitionHoldings(rows = []) {
  const physical = [];
  const nft = [];
  for (const row of rows) {
    if (isNftHolding(row)) nft.push(row);
    else physical.push(row);
  }
  return { physical, nft, ownedCards: sumOwnedQuantity(rows) };
}

function listingIdOf(listing) {
  return String(listing?.id || listing?.listingId || '');
}

function listingCardId(listing) {
  return String(listing?.cardId || listing?.card_id || '');
}

function listingSourceId(listing) {
  return String(listing?.sourceListingId || listing?.source_listing_id || '');
}

/**
 * Left side is owned and not for sale. Right side is a live or paused listing.
 * A listed card stays owned: it is the same holding, linked by listing id,
 * the listing's source id, or one unmatched copy of the same card.
 */
export function splitOwnedDesk(holdings = [], listings = []) {
  const live = (Array.isArray(listings) ? listings : []).filter(isLiveInventoryListing);
  const liveById = new Map(live.map((row) => [listingIdOf(row), row]));
  const usedListings = new Set();
  const held = [];
  const listed = [];
  const free = [];
  const nfts = [];

  for (const holding of holdings || []) {
    if (isNftHolding(holding)) {
      nfts.push({ kind: 'nft', holding });
      continue;
    }
    const linkedId = String(holding?.listingId || '');
    const linked = linkedId && liveById.get(linkedId);
    if (linked) {
      usedListings.add(listingIdOf(linked));
      listed.push({ kind: 'linked', holding, listing: linked });
      continue;
    }
    free.push(holding);
  }

  for (const listing of live) {
    const id = listingIdOf(listing);
    if (usedListings.has(id)) continue;
    const sourceId = listingSourceId(listing);
    const sourceIndex = sourceId
      ? free.findIndex((holding) => String(holding.id) === sourceId)
      : -1;
    if (sourceIndex >= 0) {
      const [holding] = free.splice(sourceIndex, 1);
      usedListings.add(id);
      listed.push({ kind: 'linked', holding, listing });
      continue;
    }
    const cardId = listingCardId(listing);
    const cardIndex = cardId
      ? free.findIndex((holding) => String(holding.cardId || holding.blueprintId || '') === cardId)
      : -1;
    if (cardIndex >= 0) {
      const [holding] = free.splice(cardIndex, 1);
      usedListings.add(id);
      listed.push({ kind: 'matched', holding, listing });
      continue;
    }
    listed.push({ kind: 'listing', listing });
  }

  for (const holding of free) held.push({ kind: 'holding', holding });
  held.push(...nfts);
  return { held, listed };
}

/** Cheapest Pokoin ask, else the sold median, as the collection listing suggestion. */
export function suggestedHoldingAsk(prices, holding) {
  const value = inventoryMarketValue(prices, {
    ...holding,
    cardId: holding?.cardId || holding?.blueprintId,
  }, 'pokoin');
  if (!value?.value) return '';
  return String(Math.round(value.value));
}
