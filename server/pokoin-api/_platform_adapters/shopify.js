'use strict';

/**
 * Shopify adapter — also serves the `binderpos` provider (BinderPOS stores are
 * Shopify stores). Contract: docs/PLATFORM_SYNC.md ("Shopify / BinderPOS").
 *
 * Every entry point takes `ctx = { credentials, metadata, fetchFn, env }` as
 * its first argument so tests can inject a fake fetch. Stock writes are always
 * relative deltas, never absolute quantities. Error messages never contain a
 * token or secret.
 */

const crypto = require('node:crypto');

const API_VERSION = '2025-07';
const TIMEOUT_MS = 20000;
const MAX_ORDER_PAGES = 20;
const MAX_INVENTORY_PAGES = 40;
const WEBHOOK_TOPICS = ['orders/paid', 'orders/cancelled'];
const SHOP_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

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

async function shopifyFetch(ctx, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchFnOf(ctx)(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw platformError('shopify_timeout', 'Shopify did not answer in time.', 502);
    }
    throw platformError('shopify_unreachable', 'Pokoin could not reach Shopify.', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Response-like objects from tests expose json(); be tolerant of a bad body. */
async function responseJson(response) {
  if (!response || typeof response.json !== 'function') return null;
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

/** Case-insensitive header read for both Headers instances and plain objects. */
function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return cleanText(headers.get(name), 4000);
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return cleanText(headers[key], 4000);
  }
  return '';
}

function shopifyResponseError(status) {
  if (status === 401 || status === 403) {
    return platformError(
      'shopify_rejected',
      `Shopify rejected this store's credentials (HTTP ${status}).`,
      401,
    );
  }
  return platformError('shopify_upstream_error', `Shopify request failed with HTTP ${status}.`, 502);
}

function authHeaders(ctx, extra = {}) {
  return {
    Accept: 'application/json',
    'X-Shopify-Access-Token': cleanText(ctx && ctx.credentials && ctx.credentials.accessToken, 400),
    ...extra,
  };
}

async function shopifyJson(ctx, url, options = {}) {
  const response = await shopifyFetch(ctx, url, options);
  const payload = await responseJson(response);
  if (!response.ok) throw shopifyResponseError(response.status);
  return payload;
}

/**
 * Accept `name`, `name.myshopify.com` or an https URL of the admin API and
 * return `name.myshopify.com`. The name part must be a valid Shop handle.
 */
function normalizeShopDomain(input) {
  let value = cleanText(input, 255);
  if (!value) throw platformError('shopify_shop_invalid', 'Enter a valid Shopify shop domain.', 400);
  value = value.replace(/^https?:\/\//i, '');
  value = value.split('/')[0].split('?')[0].split('#')[0];
  value = value.replace(/:\d+$/, '').replace(/\.+$/, '');
  const suffix = '.myshopify.com';
  const name = value.toLowerCase().endsWith(suffix) ? value.slice(0, -suffix.length) : value;
  if (!SHOP_NAME_RE.test(name)) {
    throw platformError('shopify_shop_invalid', 'Enter a valid Shopify shop domain.', 400);
  }
  return `${name}${suffix}`;
}

function shopBase(ctx) {
  const raw = (ctx && ctx.metadata && ctx.metadata.shopDomain)
    || (ctx && ctx.credentials && ctx.credentials.shopDomain)
    || '';
  return `https://${normalizeShopDomain(raw)}/admin/api/${API_VERSION}`;
}

/** Connect: read the shop, then remember its first active location. */
async function validate(ctx, input = {}) {
  const shopDomain = cleanText(input.shopDomain, 255);
  const accessToken = cleanText(input.accessToken, 400);
  const apiSecretKey = cleanText(input.apiSecretKey, 400);
  if (!shopDomain || !accessToken || !apiSecretKey) {
    throw platformError(
      'shopify_fields_required',
      'Shop domain, Admin API access token and API secret key are all required.',
      400,
    );
  }
  const domain = normalizeShopDomain(shopDomain);
  const base = `https://${domain}/admin/api/${API_VERSION}`;
  const headers = { Accept: 'application/json', 'X-Shopify-Access-Token': accessToken };
  const shop = await shopifyJson(ctx, `${base}/shop.json`, { headers });
  const locations = await shopifyJson(ctx, `${base}/locations.json`, { headers });
  const list = Array.isArray(locations)
    ? locations
    : (Array.isArray(locations?.locations) ? locations.locations : []);
  const active = list.find((location) => location && location.active === true) || list[0] || null;
  return {
    credentials: { accessToken, apiSecretKey },
    metadata: {
      shopDomain: domain,
      shopName: cleanText(shop?.shop?.name, 200),
      currency: cleanText(shop?.shop?.currency, 8),
      locationId: active ? String(active.id) : '',
      locationName: active ? cleanText(active.name, 200) : '',
    },
  };
}

async function registerWebhooks(ctx, url) {
  const address = cleanText(url, 2000);
  if (!address) throw platformError('shopify_webhook_url_required', 'A webhook address is required.', 400);
  const base = shopBase(ctx);
  const ids = [];
  for (const topic of WEBHOOK_TOPICS) {
    const payload = await shopifyJson(ctx, `${base}/webhooks.json`, {
      method: 'POST',
      headers: authHeaders(ctx, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
    });
    const id = payload?.webhook?.id;
    if (id != null && id !== '') ids.push(String(id));
  }
  return { ids };
}

async function removeWebhooks(ctx, ids) {
  const list = Array.isArray(ids) ? ids : [];
  let removed = 0;
  for (const entry of list) {
    const id = cleanText(entry && typeof entry === 'object' ? entry.id : entry, 80);
    if (!id) continue;
    const response = await shopifyFetch(
      ctx,
      `${shopBase(ctx)}/webhooks/${encodeURIComponent(id)}.json`,
      { method: 'DELETE', headers: authHeaders(ctx) },
    );
    if (response.status === 404) continue;
    if (!response.ok) throw shopifyResponseError(response.status);
    removed += 1;
  }
  return { removed };
}

/** Timing-safe HMAC of the raw body against the app's API secret key. */
function verifyWebhook(rawBody, headers, credentials) {
  const provided = cleanText(headerValue(headers, 'x-shopify-hmac-sha256'), 400);
  const secret = String(credentials && credentials.apiSecretKey ? credentials.apiSecretKey : '');
  if (!provided || !secret || rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(body).digest();
  const expected = Buffer.from(provided, 'base64');
  if (expected.length !== digest.length) return false;
  try {
    return crypto.timingSafeEqual(expected, digest);
  } catch (_) {
    return false;
  }
}

/** One order's line items in the adapter sold-item shape. */
function orderItems(order = {}) {
  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  const items = [];
  for (const line of lines) {
    if (!line || line.variant_id == null || line.variant_id === '') continue;
    items.push({
      orderId: String(order.id == null ? '' : order.id),
      itemId: String(line.id == null ? '' : line.id),
      externalId: String(line.variant_id),
      sku: cleanText(line.sku, 160),
      quantity: Number(line.quantity) || 0,
      unitPriceCents: Math.round(Number(line.price) * 100) || 0,
      currency: cleanText(order.currency, 8),
      soldAt: order.processed_at || order.created_at || null,
    });
  }
  return items;
}

function decodeWebhookBody(body) {
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8') || '{}');
  if (typeof body === 'string') return JSON.parse(body || '{}');
  return body && typeof body === 'object' ? body : {};
}

function parseWebhook(body, headers) {
  const topic = cleanText(headerValue(headers, 'x-shopify-topic'), 120).toLowerCase();
  if (topic !== 'orders/paid' && topic !== 'orders/cancelled') return { kind: 'ignore', items: [] };
  let order;
  try {
    order = decodeWebhookBody(body);
  } catch (_) {
    return { kind: 'ignore', items: [] };
  }
  return {
    kind: topic === 'orders/paid' ? 'sale' : 'cancel',
    items: orderItems(order),
  };
}

function linkNext(response) {
  const link = headerValue(response && response.headers, 'link');
  if (!link) return '';
  const match = String(link).match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  return match ? match[1] : '';
}

/** Paid orders newer than `since`; a capped or failed read is incomplete. */
async function fetchSoldItems(ctx, { since } = {}) {
  const base = shopBase(ctx);
  const params = new URLSearchParams({
    status: 'any',
    financial_status: 'paid',
    limit: '250',
  });
  if (since) params.set('updated_at_min', String(since));
  let url = `${base}/orders.json?${params.toString()}`;
  const sales = [];
  const cancels = [];
  let page = 0;
  while (page < MAX_ORDER_PAGES) {
    page += 1;
    let response;
    try {
      response = await shopifyFetch(ctx, url, { headers: authHeaders(ctx) });
    } catch (_) {
      return { complete: false, sales, cancels };
    }
    if (!response.ok) return { complete: false, sales, cancels };
    const orders = await responseJson(response);
    if (!Array.isArray(orders)) return { complete: false, sales, cancels };
    for (const order of orders) {
      const items = orderItems(order);
      if (order && order.cancelled_at) cancels.push(...items);
      else sales.push(...items);
    }
    const next = linkNext(response);
    if (!next) return { complete: true, sales, cancels };
    url = next;
  }
  return { complete: false, sales, cancels };
}

const PRODUCT_VARIANTS_QUERY = `query ProductVariants($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId
      sku
      title
      inventoryQuantity
      inventoryItem { legacyResourceId }
      product { title }
    }
  }
}`;

function shapeVariant(node = {}) {
  const productTitle = cleanText(node.product && node.product.title, 240);
  const variantTitle = cleanText(node.title, 240);
  return {
    externalId: String(node.legacyResourceId == null ? '' : node.legacyResourceId),
    sku: cleanText(node.sku, 160),
    title: `${productTitle} ${variantTitle}`.trim(),
    quantity: Number(node.inventoryQuantity) || 0,
    meta: {
      inventoryItemId: String(
        node.inventoryItem && node.inventoryItem.legacyResourceId != null
          ? node.inventoryItem.legacyResourceId
          : '',
      ),
    },
  };
}

/** Full variant list, linked by SKU; capped or failed reads are incomplete. */
async function listInventory(ctx) {
  const base = shopBase(ctx);
  const items = [];
  let cursor = null;
  let page = 0;
  while (page < MAX_INVENTORY_PAGES) {
    page += 1;
    let payload;
    try {
      payload = await shopifyJson(ctx, `${base}/graphql.json`, {
        method: 'POST',
        headers: authHeaders(ctx, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: PRODUCT_VARIANTS_QUERY, variables: { cursor } }),
      });
    } catch (_) {
      return { complete: false, items };
    }
    if (payload && Array.isArray(payload.errors) && payload.errors.length) {
      return { complete: false, items };
    }
    const block = payload?.data?.productVariants;
    const nodes = Array.isArray(block?.nodes) ? block.nodes : [];
    for (const node of nodes) items.push(shapeVariant(node));
    const pageInfo = block?.pageInfo || {};
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) return { complete: true, items };
    cursor = pageInfo.endCursor;
  }
  return { complete: false, items };
}

function externalMeta(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

/** Relative stock delta through GraphQL inventoryAdjustQuantities. */
async function adjustStock(ctx, { link, delta } = {}) {
  const amount = Math.trunc(Number(delta) || 0);
  if (!amount) return { ok: false, error: 'shopify_no_delta' };
  const externalId = cleanText(link && link.external_id, 160);
  const meta = externalMeta(link && link.external_meta);
  let inventoryItemId = cleanText(meta.inventoryItemId, 160);
  const base = shopBase(ctx);
  if (!inventoryItemId) {
    if (!externalId) return { ok: false, error: 'shopify_link_incomplete' };
    const payload = await shopifyJson(ctx, `${base}/variants/${encodeURIComponent(externalId)}.json`, {
      headers: authHeaders(ctx),
    });
    inventoryItemId = cleanText(payload?.variant?.inventory_item_id, 160);
  }
  if (!inventoryItemId) return { ok: false, error: 'shopify_link_incomplete' };
  const locationId = cleanText(ctx && ctx.metadata && ctx.metadata.locationId, 160);
  const query = `mutation {
  inventoryAdjustQuantities(input: {
    reason: "correction",
    name: "available",
    changes: [{
      delta: ${amount},
      inventoryItemId: "gid://shopify/InventoryItem/${inventoryItemId}",
      locationId: "gid://shopify/Location/${locationId}"
    }]
  }) {
    userErrors { field message }
  }
}`;
  const payload = await shopifyJson(ctx, `${base}/graphql.json`, {
    method: 'POST',
    headers: authHeaders(ctx, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query }),
  });
  if (payload && Array.isArray(payload.errors) && payload.errors.length) {
    const messages = payload.errors
      .map((row) => cleanText(row && row.message, 240))
      .filter(Boolean);
    return { ok: false, error: messages.join('; ') || 'shopify_graphql_error' };
  }
  const userErrors = payload?.data?.inventoryAdjustQuantities?.userErrors;
  if (Array.isArray(userErrors) && userErrors.length) {
    const messages = userErrors
      .map((row) => cleanText(row && (row.message || row.field), 240))
      .filter(Boolean);
    return { ok: false, error: messages.join('; ') || 'shopify_adjust_rejected' };
  }
  return { ok: true };
}

module.exports = {
  API_VERSION,
  WEBHOOK_TOPICS,
  normalizeShopDomain,
  validate,
  registerWebhooks,
  removeWebhooks,
  verifyWebhook,
  parseWebhook,
  fetchSoldItems,
  listInventory,
  adjustStock,
};
