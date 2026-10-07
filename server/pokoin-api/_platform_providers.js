'use strict';

const PROVIDERS = [
  {
    id: 'shopify',
    label: 'Shopify',
    authType: 'fields',
    adapter: 'shopify',
    fields: [
      { name: 'shopDomain', label: 'Shop domain', type: 'text', placeholder: 'your-store.myshopify.com', required: true },
      { name: 'accessToken', label: 'Admin API access token', type: 'password', placeholder: 'shpat_...', required: true },
      { name: 'apiSecretKey', label: 'API secret key (custom app)', type: 'password', placeholder: '...', required: true },
    ],
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/admin-app-access-tokens',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: true, poll: true, import: true },
    requiredEnv: [],
  },
  {
    id: 'binderpos',
    label: 'BinderPOS',
    authType: 'fields',
    adapter: 'shopify',
    fields: [
      { name: 'shopDomain', label: 'Shop domain', type: 'text', placeholder: 'your-store.myshopify.com', required: true },
      { name: 'accessToken', label: 'Admin API access token', type: 'password', placeholder: 'shpat_...', required: true },
      { name: 'apiSecretKey', label: 'API secret key (custom app)', type: 'password', placeholder: '...', required: true },
    ],
    docsUrl: 'https://www.binderpos.com/api-docs',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: true, poll: true, import: true },
    requiredEnv: [],
  },
  {
    id: 'tcgplayer',
    label: 'TCGplayer',
    authType: 'fields',
    adapter: 'tcgplayer',
    fields: [
      { name: 'authCode', label: 'Store authorization code', type: 'password', placeholder: '...', required: true },
    ],
    docsUrl: 'https://docs.tcgplayer.com/',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: false, poll: true, import: true },
    requiredEnv: ['TCGPLAYER_PUBLIC_KEY', 'TCGPLAYER_PRIVATE_KEY'],
  },
  {
    id: 'cardmarket',
    label: 'Cardmarket',
    authType: 'oauth_redirect',
    adapter: 'cardmarket',
    fields: [],
    docsUrl: 'https://api.cardmarket.com/ws/documentation/API_2.0:Main_Page',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: false, poll: true, import: true },
    requiredEnv: ['CARDMARKET_APP_TOKEN', 'CARDMARKET_APP_SECRET'],
  },
  {
    id: 'ccgseller',
    label: 'CCGSeller',
    authType: 'partner',
    adapter: 'partner',
    fields: [
      { name: 'apiKey', label: 'API key', type: 'password', placeholder: '...', required: true },
      { name: 'storeId', label: 'Store ID', type: 'text', placeholder: '...', required: false },
    ],
    docsUrl: '',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: false, poll: false, import: false },
    requiredEnv: ['PLATFORM_CCGSELLER_API_BASE'],
  },
  {
    id: 'storepass',
    label: 'Storepass',
    authType: 'partner',
    adapter: 'partner',
    fields: [
      { name: 'apiKey', label: 'API key', type: 'password', placeholder: '...', required: true },
      { name: 'storeId', label: 'Store ID', type: 'text', placeholder: '...', required: false },
    ],
    docsUrl: '',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: false, poll: false, import: false },
    requiredEnv: ['PLATFORM_STOREPASS_API_BASE'],
  },
  {
    id: 'sortswift',
    label: 'Sortswift',
    authType: 'partner',
    adapter: 'partner',
    fields: [
      { name: 'apiKey', label: 'API key', type: 'password', placeholder: '...', required: true },
      { name: 'storeId', label: 'Store ID', type: 'text', placeholder: '...', required: false },
    ],
    docsUrl: '',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: false, poll: false, import: false },
    requiredEnv: ['PLATFORM_SORTSWIFT_API_BASE'],
  },
  {
    id: 'magus',
    label: 'Magus Shop',
    authType: 'partner',
    adapter: 'partner',
    fields: [
      { name: 'apiKey', label: 'API key', type: 'password', placeholder: '...', required: true },
      { name: 'storeId', label: 'Store ID', type: 'text', placeholder: '...', required: false },
    ],
    docsUrl: '',
    intro: 'Pokoin only reads your orders and adjusts stock quantities.',
    capabilities: { webhook: false, poll: false, import: false },
    requiredEnv: ['PLATFORM_MAGUS_API_BASE'],
  },
];

const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  return PROVIDER_BY_ID[id] || null;
}

function isAvailable(provider, env = process.env) {
  if (!provider) return false;
  const required = provider.requiredEnv || [];
  if (required.length === 0) return true;
  return required.every((key) => env[key] && String(env[key]).trim().length > 0);
}

function partnerActive(provider, env = process.env) {
  if (!provider) return false;
  const required = provider.requiredEnv || [];
  if (required.length === 0) return false;
  return required.every((key) => env[key] && String(env[key]).trim().length > 0);
}

function publicProvider(provider, env = process.env) {
  if (!provider) return null;
  return {
    id: provider.id,
    label: provider.label,
    authType: provider.authType,
    adapter: provider.adapter,
    fields: provider.fields,
    docsUrl: provider.docsUrl,
    intro: provider.intro,
    capabilities: provider.capabilities,
    available: isAvailable(provider, env),
    partnerActive: partnerActive(provider, env),
  };
}

module.exports = {
  PROVIDERS,
  getProvider,
  isAvailable,
  partnerActive,
  publicProvider,
};