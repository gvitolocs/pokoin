'use strict';

const { quoteShipment } = require('../_checkout_core');

let commercePromise;
function loadCommerce() {
  if (!commercePromise) {
    commercePromise = import('../../../market/src/google-commerce.js');
  }
  return commercePromise;
}

async function shippingOptionsForListing(listing, {
  currency,
  countries,
  quote = quoteShipment,
  catalog,
} = {}) {
  const { countriesForCurrency, shippingMoney } = await loadCommerce();
  const destinations = countriesForCurrency(currency, countries);
  const fromCountry = String(listing?.sellerCountry || listing?.seller_country || '').toUpperCase();
  if (!fromCountry || listing?.shippingAvailable === false) return [];
  const rows = [];
  for (const country of destinations) {
    try {
      const quoted = quote({
        sellerId: listing.sellerUid || listing.seller_uid,
        fromCountry,
        toCountry: country,
        items: [{ quantity: 1 }],
        tracked: true,
        catalog,
      });
      const money = shippingMoney(quoted.amountCents, currency);
      if (!money) continue;
      rows.push({
        country,
        currency: money.currency,
        amount: money.amount,
        amountMicros: money.amountMicros,
        eurCents: quoted.amountCents,
        rateId: quoted.rateId,
      });
    } catch (error) {
      if (error.code === 'shipping_rate_missing' || error.code === 'invalid_ship_from') continue;
      throw error;
    }
  }
  return rows;
}

module.exports = { shippingOptionsForListing };
