'use strict';

/**
 * TCGplayer adapter — client-credentials bearer plus a seller store access
 * token. Contract: docs/PLATFORM_SYNC.md ("TCGplayer").
 *
 * Every entry point takes `ctx = { credentials, metadata, fetchFn, env }` so
 * tests can inject a fake fetch. The bearer is cached per API public key.
 * Errors never carry a key or token.
 */

const BASE_URL = 'https://api.tcgplayer.com';
const TIMEOUT_MS = 20000;
const MAX_PAGES = 20;
const MAX_INVENTORY_PAGES = 100;
const PAGE_SIZE = 100;
const TOKEN_SAFETY_MS = 60000;

/** public key -> { token, expiresAt } */
const tokenCache = new Map();

function _resetTokenCache() {
  tokenCache.clear();
}

function platformError(code, message, statusCode = 502) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function cleanText(value, maxLength = 240) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function fetchFnOf(ctx) {
  return (ctx && typeof ctx.fetchFn === 'function' && ctx.fetchFn) || fetch;
}

function envOf(ctx) {
  return (ctx && ctx.env) || process.env;
}

function tcgKeys(ctx) {
  const env = envOf(ctx);
  const publicKey = cleanText(env.TCGPLAYER_PUBLIC_KEY, 400);
  const privateKey = String(env.TCGPLAYER_PRIVATE_KEY == null ? '' : env.TCGPLAYER_PRIVATE_KEY).trim();
  if (!publicKey || !privateKey) {
    throw platformError('platform_unavailable', 'TCGplayer is not available on Pokoin yet.', 503);
  }
  return { publicKey, privateKey };
}

async function tcgFetch(ctx, { method = 'GET', url, headers = {}, body, contentType } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const allHeaders = { Accept: 'application/json', ...headers };
  if (contentType) allHeaders['Content-Type'] = contentType;
  try {
    return await fetchFnOf(ctx)(url, { method, headers: allHeaders, body, signal: controller.signal });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw platformError('tcgplayer_timeout', 'TCGplayer did not answer in time.', 502);
    }
    throw platformError('tcgplayer_unreachable', 'Pokoin could not reach TCGplayer.', 502);
  } finally {
    clearTimeout(timer);
  }
}

async function responseJson(response) {
  if (!response || typeof response.json !== 'function') return null;
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

function tcgplayerResponseError(status) {
  if (status === 401 || status === 403) {
    return platformError(
      'tcgplayer_rejected',
      `TCGplayer rejected these credentials (HTTP ${status}).`,
      401,
    );
  }
  return platformError('tcgplayer_upstream_error', `TCGplayer request failed with HTTP ${status}.`, 502);
}

function errorText(payload) {
  const rows = payload && Array.isArray(payload.errors) ? payload.errors : [];
  const messages = rows
    .map((row) => cleanText(row && (row.message || row.errorMessage || row), 240))
    .filter(Boolean);
  return messages.join('; ') || cleanText(payload && payload.message, 240);
}

/** Client-credentials bearer, cached per public key until 60 s before expiry. */
async function bearerToken(ctx) {
  const { publicKey, privateKey } = tcgKeys(ctx);
  const cached = tokenCache.get(publicKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: publicKey,
    client_secret: privateKey,
  });
  const response = await tcgFetch(ctx, {
    method: 'POST',
    url: `${BASE_URL}/token`,
    body: body.toString(),
    contentType: 'application/x-www-form-urlencoded',
  });
  const payload = (await responseJson(response)) || {};
  if (!response.ok) throw tcgplayerResponseError(response.status);
  const token = cleanText(payload.access_token, 2000);
  if (!token) throw platformError('tcgplayer_rejected', 'TCGplayer did not return a bearer token.', 502);
  const expiresIn = Number(payload.expires_in) || 0;
  tokenCache.set(publicKey, {
    token,
    expiresAt: Date.now() + Math.max(0, expiresIn * 1000 - TOKEN_SAFETY_MS),
  });
  return token;
}

function storeKeyOf(ctx) {
  const metadata = (ctx && ctx.metadata) || {};
  const credentials = (ctx && ctx.credentials) || {};
  const key = cleanText(metadata.storeKey || credentials.storeKey, 80);
  if (!key) {
    throw platformError('tcgplayer_store_missing', 'Connect the TCGplayer store first.', 400);
  }
  return key;
}

function storeHeaders(ctx, token) {
  const accessToken = cleanText(ctx && ctx.credentials && ctx.credentials.accessToken, 2000);
  const headers = { Authorization: `bearer ${token}` };
  if (accessToken) headers['X-Tcg-Access-Token'] = accessToken;
  return headers;
}

/** Connect: authorize the pasted store code, then read the store identity. */
async function validate(ctx, input = {}) {
  const authCode = cleanText(input.authCode, 400);
  if (!authCode) {
    throw platformError('tcgplayer_auth_code_required', 'Enter the TCGplayer store authorization code.', 400);
  }
  const token = await bearerToken(ctx);
  const authorizeResponse = await tcgFetch(ctx, {
    method: 'POST',
    url: `${BASE_URL}/app/authorize/${encodeURIComponent(authCode)}`,
    headers: { Authorization: `bearer ${token}` },
  });
  const authorizePayload = (await responseJson(authorizeResponse)) || {};
  if (!authorizeResponse.ok) throw tcgplayerResponseError(authorizeResponse.status);
  const accessToken = cleanText(authorizePayload.accessToken, 2000);
  if (!accessToken) {
    throw platformError('tcgplayer_rejected', 'TCGplayer did not return a store access token.', 502);
  }

  const storeResponse = await tcgFetch(ctx, {
    method: 'GET',
    url: `${BASE_URL}/stores/self`,
    headers: { Authorization: `bearer ${token}`, 'X-Tcg-Access-Token': accessToken },
  });
  const storePayload = (await responseJson(storeResponse)) || {};
  if (!storeResponse.ok) throw tcgplayerResponseError(storeResponse.status);
  const store = Array.isArray(storePayload.results) ? storePayload.results[0] : null;
  if (!store) {
    throw platformError('tcgplayer_rejected', 'TCGplayer did not return a store for this account.', 502);
  }
  return {
    credentials: { accessToken },
    metadata: {
      storeKey: String(store.storeKey == null ? '' : store.storeKey),
      storeName: cleanText(store.name, 200),
    },
  };
}

function isCancelled(status) {
  const name = status && typeof status === 'object' ? status.name || status.statusName : status;
  return /cancel/i.test(String(name == null ? '' : name));
}

async function fetchOrderItems(ctx, token, storeKey, orderNumber) {
  const response = await tcgFetch(ctx, {
    method: 'GET',
    url: `${BASE_URL}/stores/${encodeURIComponent(storeKey)}/orders/${encodeURIComponent(String(orderNumber))}/items`,
    headers: storeHeaders(ctx, token),
  });
  const payload = (await responseJson(response)) || {};
  if (!response.ok) throw tcgplayerResponseError(response.status);
  return Array.isArray(payload.results) ? payload.results : [];
}

function shapeOrderItems(order, rows) {
  const soldAt = order.orderDate || null;
  return rows.map((row) => ({
    orderId: String(order.orderNumber == null ? '' : order.orderNumber),
    itemId: String(row.skuId == null ? '' : row.skuId),
    externalId: String(row.skuId == null ? '' : row.skuId),
    quantity: Number(row.quantity) || 0,
    unitPriceCents: Math.round(Number(row.price) * 100) || 0,
    currency: 'USD',
    soldAt,
  }));
}

/** Store orders newest first, stopping at `since`; a capped/failed read is incomplete. */
async function fetchSoldItems(ctx, { since } = {}) {
  const storeKey = storeKeyOf(ctx);
  const token = await bearerToken(ctx);
  const sinceMs = since ? new Date(since).getTime() : 0;
  const sales = [];
  const cancels = [];
  let offset = 0;
  let page = 0;
  while (page < MAX_PAGES) {
    page += 1;
    const url = `${BASE_URL}/stores/${encodeURIComponent(storeKey)}/orders`
      + `?limit=${PAGE_SIZE}&offset=${offset}&sort=OrderDate%20Desc`;
    let response;
    try {
      response = await tcgFetch(ctx, { method: 'GET', url, headers: storeHeaders(ctx, token) });
    } catch (_) {
      return { complete: false, sales, cancels };
    }
    const payload = (await responseJson(response)) || {};
    if (!response.ok) return { complete: false, sales, cancels };
    const orders = Array.isArray(payload.results) ? payload.results : [];
    if (orders.length === 0) return { complete: true, sales, cancels };
    let reachedSince = false;
    for (const order of orders) {
      const orderMs = order.orderDate ? new Date(order.orderDate).getTime() : 0;
      if (sinceMs && orderMs && orderMs < sinceMs) {
        reachedSince = true;
        break;
      }
      let rows;
      try {
        rows = await fetchOrderItems(ctx, token, storeKey, order.orderNumber);
      } catch (_) {
        return { complete: false, sales, cancels };
      }
      const items = shapeOrderItems(order, rows);
      if (isCancelled(order.status)) cancels.push(...items);
      else sales.push(...items);
    }
    if (reachedSince || orders.length < PAGE_SIZE) return { complete: true, sales, cancels };
    offset += PAGE_SIZE;
  }
  return { complete: false, sales, cancels };
}

function nameOf(value) {
  if (value && typeof value === 'object') return cleanText(value.name || value.conditionName || value.languageName, 80);
  return cleanText(value, 80);
}

function productSkus(product = {}) {
  if (Array.isArray(product.skus)) return product.skus;
  if (Array.isArray(product.skus?.results)) return product.skus.results;
  return [];
}

function shapeInventorySku(product, sku) {
  const printing = sku.printing && typeof sku.printing === 'object' ? sku.printing.name : sku.printing;
  return {
    externalId: String(sku.skuId == null ? '' : sku.skuId),
    sku: String(sku.skuId == null ? '' : sku.skuId),
    name: cleanText(product.name || product.productName, 240),
    setName: cleanText(product.group && product.group.name, 240),
    collectorNumber: '',
    condition: nameOf(sku.condition),
    language: nameOf(sku.language),
    foil: /foil/i.test(String(printing == null ? '' : printing)),
    quantity: Number(sku.quantity) || 0,
    priceCents: Math.round(Number(sku.price) * 100) || 0,
    currency: 'USD',
    meta: { productId: String(product.productId == null ? '' : product.productId) },
  };
}

/** Seller inventory products, paged; unmatched SKUs feed the catalog import. */
async function listInventory(ctx) {
  const storeKey = storeKeyOf(ctx);
  const token = await bearerToken(ctx);
  const items = [];
  let offset = 0;
  let page = 0;
  while (page < MAX_INVENTORY_PAGES) {
    page += 1;
    const url = `${BASE_URL}/stores/${encodeURIComponent(storeKey)}/inventory/products`
      + `?limit=${PAGE_SIZE}&offset=${offset}`;
    let response;
    try {
      response = await tcgFetch(ctx, { method: 'GET', url, headers: storeHeaders(ctx, token) });
    } catch (_) {
      return { complete: false, items };
    }
    const payload = (await responseJson(response)) || {};
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw tcgplayerResponseError(response.status);
      return { complete: false, items };
    }
    const products = Array.isArray(payload.results) ? payload.results : [];
    if (products.length === 0) return { complete: true, items };
    for (const product of products) {
      for (const sku of productSkus(product)) items.push(shapeInventorySku(product, sku));
    }
    if (products.length < PAGE_SIZE) return { complete: true, items };
    offset += PAGE_SIZE;
  }
  return { complete: false, items };
}

/** Relative stock delta on one SKU. */
async function adjustStock(ctx, { link, delta } = {}) {
  const amount = Math.trunc(Number(delta) || 0);
  if (!amount) return { ok: false, error: 'tcgplayer_no_delta' };
  const externalId = cleanText(link && link.external_id, 160);
  if (!externalId) return { ok: false, error: 'tcgplayer_link_incomplete' };
  const storeKey = storeKeyOf(ctx);
  const token = await bearerToken(ctx);
  const response = await tcgFetch(ctx, {
    method: 'POST',
    url: `${BASE_URL}/stores/${encodeURIComponent(storeKey)}/inventory/skus/${encodeURIComponent(externalId)}/quantity`,
    headers: storeHeaders(ctx, token),
    contentType: 'application/json',
    body: JSON.stringify({ quantity: amount }),
  });
  const payload = (await responseJson(response)) || {};
  if (!response.ok) throw tcgplayerResponseError(response.status);
  if (payload.success === false) {
    return { ok: false, error: errorText(payload) || 'tcgplayer_rejected' };
  }
  return { ok: true };
}

module.exports = {
  BASE_URL,
  _resetTokenCache,
  validate,
  fetchSoldItems,
  listInventory,
  adjustStock,
};
