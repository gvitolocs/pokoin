const crypto = require('node:crypto');

const CARDTRADER_API_BASE_URL = 'https://api.cardtrader.com/api/v2';

// CardTrader API tokens are RS256 JWTs. Copies from CardTrader's wrapped
// textarea, a "Bearer " prefix, or a password manager filling the field can
// surround a valid token with extra text, and CardTrader answers 401 for it.
// market/src/cardtrader-token.js mirrors this for the Profile connect panel.
const TOKEN_NOISE_RE = /[\s\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const RSA_ALG_RE = /^(RS|PS)\d+$/;
const RSA_SIGNATURE_BYTES = new Set([256, 384, 512]);

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanToken(value) {
  const compact = String(value || '').replace(TOKEN_NOISE_RE, '');
  const jwt = compact.match(JWT_RE);
  if (jwt) return jwt[0];
  return compact
    .replace(/^(?:authorization:)?bearer/i, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

function decodeJwtSegment(segment) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

/** Non-secret facts about a token for logs and hints — never the token or its signature. */
function tokenFingerprint(token) {
  const clean = String(token || '');
  const parts = clean.split('.');
  const header = parts.length === 3 ? decodeJwtSegment(parts[0]) : null;
  const claims = header ? decodeJwtSegment(parts[1]) : null;
  const jwt = Boolean(header && claims);
  const signatureBytes = jwt ? Buffer.from(parts[2], 'base64url').length : 0;
  const alg = cleanText(header?.alg, 20);
  return {
    length: clean.length,
    sha256: crypto.createHash('sha256').update(clean).digest('hex').slice(0, 12),
    jwt,
    complete: jwt && (RSA_ALG_RE.test(alg) ? RSA_SIGNATURE_BYTES.has(signatureBytes) : signatureBytes > 0),
    alg,
    sub: cleanText(claims?.sub, 80),
    name: cleanText(claims?.name, 160),
    issuedAt: Number.isFinite(claims?.iat) ? new Date(claims.iat * 1000).toISOString() : '',
    signatureBytes,
  };
}

function cardTraderError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cardTraderResponseError(status, payload, path, token) {
  const errorCode = cleanText(payload?.error_code, 80);
  // A 403 without CardTrader's JSON error body is an edge block (Cloudflare),
  // not a verdict on the token.
  if (status === 403 && !errorCode) {
    const error = cardTraderError('CardTrader blocked the request from Pokoin (HTTP 403). Try again in a few minutes.');
    error.code = 'cardtrader_blocked';
    return error;
  }
  if (status === 401 || status === 403) {
    const fingerprint = tokenFingerprint(token);
    console.warn('cardtrader token rejected', {
      path,
      httpStatus: status,
      errorCode,
      requestId: cleanText(payload?.request_id, 80),
      token: fingerprint,
    });
    const hint = fingerprint.complete
      ? 'Copy the current token from your CardTrader settings; regenerating it there stops older tokens working.'
      : 'The pasted value is not a complete CardTrader token. Clear the field and paste it again with CardTrader\'s Copy button.';
    const error = cardTraderError(`CardTrader rejected this API token (HTTP ${status}). ${hint}`, 400);
    error.code = 'cardtrader_token_rejected';
    return error;
  }
  return cardTraderError(`CardTrader request failed with HTTP ${status}.`);
}

async function cardTraderRequest(path, token, options = {}) {
  const cleanPath = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  const response = await fetch(`${CARDTRADER_API_BASE_URL}${cleanPath}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = null;
    }
  }
  if (!response.ok) {
    throw cardTraderResponseError(response.status, payload, cleanPath, token);
  }
  return payload;
}

async function validateCardTraderToken(token) {
  const clean = cleanToken(token);
  if (clean.length < 16) {
    const error = new Error('Enter a valid CardTrader API token.');
    error.statusCode = 400;
    throw error;
  }
  const info = await cardTraderRequest('/info', clean);
  return normalizeInfo(info);
}

async function fetchProductsExport(token) {
  const payload = await cardTraderRequest('/products/export', cleanToken(token));
  // Never coerce a non-array into [] — that would look like an empty inventory
  // and incorrectly allow destructive disappearance reconciliation.
  if (!Array.isArray(payload)) {
    const error = new Error('CardTrader products/export did not return an array.');
    error.statusCode = 502;
    error.incomplete = true;
    throw error;
  }
  return payload;
}

async function fetchMarketplaceProducts(token, params = {}) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  const payload = await cardTraderRequest(
    `/marketplace/products${query ? `?${query}` : ''}`,
    cleanToken(token),
  );
  return payload && typeof payload === 'object' ? payload : {};
}

async function fetchCart(token) {
  const payload = await cardTraderRequest('/cart', cleanToken(token));
  return payload && typeof payload === 'object' ? payload : {};
}

async function addProductToCart(token, payload = {}) {
  return cardTraderRequest('/cart/add', cleanToken(token), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function purchaseCart(token) {
  return cardTraderRequest('/cart/purchase', cleanToken(token), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
}

async function createProduct(token, payload = {}) {
  return cardTraderRequest('/products', cleanToken(token), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function updateProduct(token, productId, payload = {}) {
  const id = cleanText(productId, 80);
  return cardTraderRequest(`/products/${encodeURIComponent(id)}`, cleanToken(token), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function destroyProduct(token, productId) {
  const id = cleanText(productId, 80);
  return cardTraderRequest(`/products/${encodeURIComponent(id)}`, cleanToken(token), {
    method: 'DELETE',
  });
}

async function updateAppWebhookUrl(token, webhookUrl) {
  return cardTraderRequest('/app', cleanToken(token), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook_url: webhookUrl == null ? '' : String(webhookUrl),
    }),
  });
}

function cardTraderWebhookUrlForUid(uid) {
  const base = String(process.env.CARDTRADER_WEBHOOK_BASE_URL || 'https://api.pokoin.com')
    .trim()
    .replace(/\/+$/, '');
  const cleanUid = cleanText(uid, 160);
  if (!cleanUid) return '';
  return `${base}/api/cardtrader-webhook/${encodeURIComponent(cleanUid)}`;
}

function normalizeInfo(info = {}) {
  const user = info.user && typeof info.user === 'object' ? info.user : {};
  const app = info.app && typeof info.app === 'object' ? info.app : {};
  // GET /info answers flat for app tokens: { id, name, user_id, shared_secret }.
  return {
    app: {
      id: cleanText(app.id ?? info.app_id ?? info.id, 80),
      name: cleanText(app.name ?? info.app_name ?? info.name, 160),
    },
    user: {
      id: cleanText(user.id ?? info.user_id, 80),
      email: cleanText(user.email ?? info.email, 320).toLowerCase(),
      username: cleanText(user.username ?? user.name ?? info.username, 160),
    },
    scopes: Array.isArray(info.scopes)
      ? info.scopes.map((scope) => cleanText(scope, 80)).filter(Boolean).slice(0, 50)
      : [],
    seller: {
      id: cleanText(info.seller_id ?? user.seller_id, 80),
      name: cleanText(info.seller_name ?? user.seller_name, 160),
    },
    sharedSecret: cleanText(info.shared_secret, 500),
  };
}

function safeInfoMetadata(info = {}) {
  return {
    app: info.app || {},
    user: info.user || {},
    scopes: Array.isArray(info.scopes) ? info.scopes : [],
    seller: info.seller || {},
  };
}

function importDryRunSummary(products) {
  const rows = Array.isArray(products) ? products : [];
  return {
    productCount: rows.length,
    sample: rows.slice(0, 10).map((row) => safeProductSample(row)),
  };
}

function safeProductSample(row = {}) {
  return {
    id: cleanText(row.id, 80),
    blueprintId: cleanText(row.blueprint_id ?? row.blueprintId, 80),
    name: cleanText(row.name ?? row.blueprint?.name, 240),
    quantity: Number(row.quantity ?? row.qty ?? 0) || 0,
    priceCents: Number(row.price_cents ?? row.priceCents ?? 0) || 0,
    state: cleanText(row.state, 80),
  };
}

module.exports = {
  addProductToCart,
  cardTraderRequest,
  cardTraderWebhookUrlForUid,
  cleanToken,
  createProduct,
  destroyProduct,
  fetchCart,
  fetchMarketplaceProducts,
  fetchProductsExport,
  importDryRunSummary,
  normalizeInfo,
  purchaseCart,
  safeInfoMetadata,
  tokenFingerprint,
  updateAppWebhookUrl,
  updateProduct,
  validateCardTraderToken,
};
