'use strict';

function productKey(row) {
  return String(row?.offerId || row?.offer_id || '').trim();
}

function remotePrice(row) {
  const price = row?.productAttributes?.price || row?.price || {};
  return {
    amountMicros: String(price.amountMicros || row.amountMicros || ''),
    currency: String(price.currencyCode || row.currency || '').toUpperCase(),
    availability: String(row?.productAttributes?.availability || row.availability || ''),
    externalSellerId: String(row?.productAttributes?.externalSellerId || row.externalSellerId || ''),
  };
}

function reconcileProducts(localInputs = [], remoteProducts = []) {
  const local = new Map();
  for (const row of localInputs) {
    const offerId = productKey(row);
    if (offerId) local.set(offerId, row);
  }
  const remote = new Map();
  for (const row of remoteProducts) {
    const offerId = productKey(row);
    if (offerId) remote.set(offerId, row);
  }
  const missing = [];
  const stale = [];
  const priceMismatch = [];
  const currencyMismatch = [];
  const sellerMismatch = [];
  for (const [offerId, item] of local) {
    const found = remote.get(offerId);
    if (!found) {
      missing.push(offerId);
      continue;
    }
    const side = remotePrice(found);
    const wantMicros = String(item.amountMicros || item.productAttributes?.price?.amountMicros || '');
    const wantCurrency = String(item.currency || item.productAttributes?.price?.currencyCode || '').toUpperCase();
    const wantSeller = String(item.externalSellerId || item.productAttributes?.externalSellerId || '');
    if (side.availability && side.availability !== 'IN_STOCK') stale.push(offerId);
    if (wantMicros && side.amountMicros && side.amountMicros !== wantMicros) priceMismatch.push(offerId);
    if (wantCurrency && side.currency && side.currency !== wantCurrency) currencyMismatch.push(offerId);
    if (wantSeller && side.externalSellerId && side.externalSellerId !== wantSeller) sellerMismatch.push(offerId);
  }
  const extra = [];
  for (const offerId of remote.keys()) {
    if (!local.has(offerId)) extra.push(offerId);
  }
  return { missing, stale, priceMismatch, currencyMismatch, sellerMismatch, extra };
}

module.exports = { reconcileProducts, remotePrice };
