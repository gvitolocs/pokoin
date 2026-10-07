'use strict';

/**
 * Provider id -> adapter module. `binderpos` reuses the Shopify adapter
 * because BinderPOS stores are Shopify stores; `ccgseller`, `storepass`,
 * `sortswift` and `magus` share the pending-activation partner adapter.
 */

const { getProvider } = require('../_platform_providers');

const LOADERS = {
  shopify: () => require('./shopify'),
  cardmarket: () => require('./cardmarket'),
  tcgplayer: () => require('./tcgplayer'),
  partner: () => require('./partner'),
};

function getAdapter(providerId) {
  const provider = getProvider(String(providerId == null ? '' : providerId).trim());
  const loader = provider ? LOADERS[provider.adapter] : null;
  if (!loader) {
    const error = new Error('Unknown platform provider.');
    error.code = 'platform_unknown';
    error.statusCode = 404;
    throw error;
  }
  return loader();
}

module.exports = { getAdapter, LOADERS };
