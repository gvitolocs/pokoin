/** Pure helpers for Portfolio / Collection owned counts. */

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
