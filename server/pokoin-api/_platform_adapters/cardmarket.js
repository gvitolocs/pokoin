'use strict';

/**
 * Cardmarket (MKM API 2.0) adapter — widget-app OAuth 1.0a HMAC-SHA1.
 * Contract: docs/PLATFORM_SYNC.md ("Cardmarket").
 *
 * App token/secret come from the Pokoin env, never from the seller. Every
 * entry point takes `ctx = { credentials, metadata, fetchFn, env }` so tests
 * can inject a fake fetch. Errors never carry a token or secret.
 */

const crypto = require('node:crypto');

const BASE_URL = 'https://api.cardmarket.com/ws/v2.0';
const TIMEOUT_MS = 20000;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

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

function appCredentials(ctx) {
  const env = envOf(ctx);
  const appToken = cleanText(env.CARDMARKET_APP_TOKEN, 400);
  const appSecret = String(env.CARDMARKET_APP_SECRET == null ? '' : env.CARDMARKET_APP_SECRET);
  if (!appToken || !appSecret) {
    throw platformError('platform_unavailable', 'Cardmarket is not available on Pokoin yet.', 503);
  }
  return { appToken, appSecret };
}

/** RFC3986 percent-encoding (OAuth 1.0a requires the unreserved set only). */
function rfc3986(value) {
  return encodeURIComponent(String(value == null ? '' : value)).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * OAuth 1.0a Authorization header for one MKM request.
 * `nonce`/`timestamp` are injectable so the signature is deterministic in tests.
 */
function oauthHeader({
  method = 'GET',
  url,
  appToken,
  appSecret,
  accessToken = '',
  accessSecret = '',
  nonce,
  timestamp,
} = {}) {
  const target = String(url == null ? '' : url);
  const queryIndex = target.indexOf('?');
  const baseUrl = queryIndex === -1 ? target : target.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : target.slice(queryIndex + 1);
  const ts = timestamp == null ? Math.floor(Date.now() / 1000) : timestamp;
  const nc = nonce == null ? crypto.randomBytes(16).toString('hex') : nonce;

  const params = [
    ['oauth_consumer_key', appToken],
    ['oauth_nonce', nc],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', ts],
    ['oauth_token', accessToken || ''],
    ['oauth_version', '1.0'],
  ];
  for (const [key, value] of new URLSearchParams(query)) params.push([key, value]);

  const pairs = params.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).sort();
  const baseString = `${String(method).toUpperCase()}&${rfc3986(baseUrl)}&${rfc3986(pairs.join('&'))}`;
  const signingKey = `${rfc3986(appSecret)}&${rfc3986(accessSecret || '')}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = [
    ['realm', baseUrl],
    ['oauth_consumer_key', appToken],
    ['oauth_nonce', nc],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', ts],
    ['oauth_token', accessToken || ''],
    ['oauth_version', '1.0'],
    ['oauth_signature', signature],
  ];
  const rendered = headerParams
    .map(([key, value]) => (key === 'realm' ? `realm="${value}"` : `${key}="${rfc3986(value)}"`))
    .join(', ');
  return `OAuth ${rendered}`;
}

function cardmarketResponseError(status) {
  if (status === 401 || status === 403) {
    return platformError(
      'cardmarket_rejected',
      `Cardmarket rejected these credentials (HTTP ${status}).`,
      401,
    );
  }
  return platformError('cardmarket_upstream_error', `Cardmarket request failed with HTTP ${status}.`, 502);
}

async function mkmFetch(ctx, { method = 'GET', url, body, contentType, auth } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = auth;
  if (contentType) headers['Content-Type'] = contentType;
  try {
    return await fetchFnOf(ctx)(url, { method, headers, body, signal: controller.signal });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw platformError('cardmarket_timeout', 'Cardmarket did not answer in time.', 502);
    }
    throw platformError('cardmarket_unreachable', 'Pokoin could not reach Cardmarket.', 502);
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

async function responseText(response) {
  if (!response || typeof response.text !== 'function') return '';
  try {
    return String(await response.text());
  } catch (_) {
    return '';
  }
}

function sellerAuth(ctx) {
  const { appToken, appSecret } = appCredentials(ctx);
  const credentials = (ctx && ctx.credentials) || {};
  return {
    appToken,
    appSecret,
    accessToken: cleanText(credentials.accessToken, 400),
    accessSecret: String(credentials.accessSecret == null ? '' : credentials.accessSecret),
  };
}

/** Where the seller logs in to Cardmarket. */
function authorizeUrl(ctx) {
  const { appToken } = appCredentials(ctx);
  return `${BASE_URL}/authenticate/${encodeURIComponent(appToken)}`;
}

/**
 * Exchange the one-time request token for an access token, then read the
 * account so the integration metadata carries the username.
 */
async function exchangeRequestToken(ctx, requestToken) {
  const { appToken, appSecret } = appCredentials(ctx);
  const token = cleanText(requestToken, 400);
  if (!token) {
    throw platformError('cardmarket_request_token_required', 'Missing Cardmarket request token.', 400);
  }

  const accessUrl = `${BASE_URL}/output.json/access`;
  const accessResponse = await mkmFetch(ctx, {
    method: 'POST',
    url: accessUrl,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><request><app_key>${appToken}</app_key><request_token>${token}</request_token></request>`,
    auth: oauthHeader({
      method: 'POST',
      url: accessUrl,
      appToken,
      appSecret,
      accessToken: token,
      accessSecret: '',
    }),
  });
  const accessPayload = (await responseJson(accessResponse)) || {};
  if (!accessResponse.ok) throw cardmarketResponseError(accessResponse.status);
  const accessToken = cleanText(accessPayload.oauth_token, 400);
  const accessSecret = String(
    accessPayload.oauth_token_secret == null ? '' : accessPayload.oauth_token_secret,
  );
  if (!accessToken) {
    throw platformError('cardmarket_rejected', 'Cardmarket did not return an access token.', 502);
  }

  const accountUrl = `${BASE_URL}/output.json/account`;
  const accountResponse = await mkmFetch(ctx, {
    method: 'GET',
    url: accountUrl,
    auth: oauthHeader({
      method: 'GET',
      url: accountUrl,
      appToken,
      appSecret,
      accessToken,
      accessSecret,
    }),
  });
  const accountPayload = (await responseJson(accountResponse)) || {};
  if (!accountResponse.ok) throw cardmarketResponseError(accountResponse.status);
  const account = accountPayload.account || accountPayload;
  return {
    credentials: { accessToken, accessSecret },
    metadata: {
      username: cleanText(account.username, 200),
      idUser: cleanText(account.idUser, 80),
      country: cleanText(account.country, 80),
    },
  };
}

function paidStamp(order = {}) {
  const state = order.state && typeof order.state === 'object' ? order.state : {};
  return state.datePaid || state.dateBought || order.datePaid || order.date || '';
}

function cancelledStamp(order = {}) {
  const state = order.state && typeof order.state === 'object' ? order.state : {};
  return state.dateCanceled || order.dateCanceled || paidStamp(order);
}

function orderArticles(order = {}) {
  if (Array.isArray(order.article)) return order.article;
  if (Array.isArray(order.articles)) return order.articles;
  return [];
}

function orderList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.order)) return payload.order;
  if (Array.isArray(payload?.orders)) return payload.orders;
  return [];
}

function shapeOrderItems(order, kind) {
  const stamp = kind === 'cancel' ? cancelledStamp(order) : paidStamp(order);
  const items = [];
  for (const article of orderArticles(order)) {
    items.push({
      orderId: String(order.idOrder == null ? '' : order.idOrder),
      itemId: String(article.idArticle == null ? '' : article.idArticle),
      externalId: String(article.idArticle == null ? '' : article.idArticle),
      idProduct: String(article.idProduct == null ? '' : article.idProduct),
      quantity: Number(article.count) || 0,
      unitPriceCents: Math.round(Number(article.price) * 100) || 0,
      currency: 'EUR',
      soldAt: stamp || null,
    });
  }
  return items;
}

/** One MKM order state, paged in blocks of 100 while the API answers 206. */
async function readOrderState(ctx, { state, kind, since }) {
  const auth = sellerAuth(ctx);
  const items = [];
  const sinceMs = since ? new Date(since).getTime() : 0;
  let start = 1;
  let page = 0;
  while (page < MAX_PAGES) {
    page += 1;
    const url = `${BASE_URL}/output.json/orders/1/${state}?start=${start}`;
    let response;
    try {
      response = await mkmFetch(ctx, {
        method: 'GET',
        url,
        auth: oauthHeader({ method: 'GET', url, ...auth }),
      });
    } catch (_) {
      return { complete: false, items };
    }
    if (response.status === 204) return { complete: true, items };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw cardmarketResponseError(response.status);
      }
      return { complete: false, items };
    }
    const payload = (await responseJson(response)) || {};
    for (const order of orderList(payload)) {
      const stamp = kind === 'cancel' ? cancelledStamp(order) : paidStamp(order);
      const stampMs = stamp ? new Date(stamp).getTime() : 0;
      if (sinceMs && stampMs && stampMs < sinceMs) continue;
      items.push(...shapeOrderItems(order, kind));
    }
    if (response.status !== 206) return { complete: true, items };
    start += PAGE_SIZE;
  }
  return { complete: false, items };
}

/** Paid seller orders since `since`, plus the cancelled ones. */
async function fetchSoldItems(ctx, { since } = {}) {
  appCredentials(ctx);
  const paid = await readOrderState(ctx, { state: 2, kind: 'sale', since });
  const cancelled = await readOrderState(ctx, { state: 128, kind: 'cancel', since });
  return {
    complete: paid.complete && cancelled.complete,
    sales: paid.items,
    cancels: cancelled.items,
  };
}

function stockArticles(payload) {
  if (Array.isArray(payload?.article)) return payload.article;
  if (Array.isArray(payload?.articles)) return payload.articles;
  if (Array.isArray(payload)) return payload;
  return [];
}

function shapeStockItem(article = {}) {
  const product = article.product && typeof article.product === 'object' ? article.product : {};
  const language = article.language && typeof article.language === 'object' ? article.language : {};
  return {
    externalId: String(article.idArticle == null ? '' : article.idArticle),
    sku: '',
    name: cleanText(product.enName || article.enName, 240),
    setName: cleanText(product.expansion || article.expansion, 240),
    collectorNumber: cleanText(product.nr || article.nr, 40),
    condition: cleanText(article.condition, 20),
    language: cleanText(language.languageName || article.languageName || article.language, 40),
    foil: article.isFoil === true,
    quantity: Number(article.count) || 0,
    priceCents: Math.round(Number(article.price) * 100) || 0,
    currency: 'EUR',
    meta: { idProduct: String(article.idProduct == null ? '' : article.idProduct) },
  };
}

/** The seller's Cardmarket stock, linked through the optional catalog import. */
async function listInventory(ctx) {
  const auth = sellerAuth(ctx);
  const items = [];
  let offset = 0;
  let page = 0;
  while (page < MAX_PAGES) {
    page += 1;
    const url = offset === 0
      ? `${BASE_URL}/output.json/stock`
      : `${BASE_URL}/output.json/stock/${offset + 1}`;
    let response;
    try {
      response = await mkmFetch(ctx, {
        method: 'GET',
        url,
        auth: oauthHeader({ method: 'GET', url, ...auth }),
      });
    } catch (_) {
      return { complete: false, items };
    }
    if (response.status === 204) return { complete: true, items };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw cardmarketResponseError(response.status);
      }
      return { complete: false, items };
    }
    const payload = (await responseJson(response)) || {};
    for (const article of stockArticles(payload)) items.push(shapeStockItem(article));
    if (response.status !== 206) return { complete: true, items };
    offset += PAGE_SIZE;
  }
  return { complete: false, items };
}

/** Relative stock delta. MKM answers 200 with a notIncrease/notDecrease list. */
async function adjustStock(ctx, { link, delta } = {}) {
  const amount = Math.trunc(Number(delta) || 0);
  if (!amount) return { ok: false, error: 'cardmarket_no_delta' };
  const articleId = cleanText(link && link.external_id, 160);
  if (!articleId) return { ok: false, error: 'cardmarket_link_incomplete' };
  const auth = sellerAuth(ctx);
  const action = amount < 0 ? 'decrease' : 'increase';
  const url = `${BASE_URL}/output.json/stock/${action}`;
  const response = await mkmFetch(ctx, {
    method: 'PUT',
    url,
    contentType: 'application/xml',
    body: `<request><article><idArticle>${articleId}</idArticle><count>${Math.abs(amount)}</count></article></request>`,
    auth: oauthHeader({ method: 'PUT', url, ...auth }),
  });
  const text = await responseText(response);
  if (!response.ok) throw cardmarketResponseError(response.status);
  const refusalKey = amount < 0 ? 'notDecreased' : 'notIncreased';
  const match = text.match(new RegExp(`<${refusalKey}>([\\s\\S]*?)</${refusalKey}>`, 'i'));
  if (match && match[1].trim()) return { ok: false, error: 'cardmarket_refused' };
  return { ok: true };
}

module.exports = {
  BASE_URL,
  oauthHeader,
  authorizeUrl,
  exchangeRequestToken,
  fetchSoldItems,
  listInventory,
  adjustStock,
};
