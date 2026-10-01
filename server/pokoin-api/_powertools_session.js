'use strict';

/**
 * Power Tools (new.tcgpowertools.com) session for a Pokoin seller.
 *
 * Power Tools has no OAuth for third-party apps. Its own sign-in is:
 *   1. Outseta password login  POST https://mtg-powertools.outseta.com/api/v1/tokens
 *      (form: username, password) → { access_token } or a two-factor challenge;
 *   2. POST https://new.tcgpowertools.com/api/auth/login { accessToken }
 *      → Set-Cookie `jwt=…` (the whole Power Tools session: cookie only, no CSRF).
 *
 * Pokoin keeps only that `jwt`, AES-GCM encrypted like the CardTrader token,
 * on `seller_integrations/{uid}__powertools`. The password is used once and
 * never stored or logged. `/api/user` also returns the seller's CardTrader
 * OAuth + refresh tokens: only the non-secret identity fields leave this module.
 */

const { decryptSecret, encryptSecret, parseEncryptionKey } = require('./_cardtrader_crypto');

const COLLECTION = 'seller_integrations';
const PROVIDER = 'powertools';
const POWERTOOLS_BASE_URL = 'https://new.tcgpowertools.com';
const OUTSETA_API_BASE_URL = 'https://mtg-powertools.outseta.com/api/v1';
const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_WINDOW_MS = 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function integrationDocId(uid) {
  return `${uid}__${PROVIDER}`;
}

function baseUrl() {
  return cleanText(process.env.POWERTOOLS_BASE_URL, 200).replace(/\/+$/, '') || POWERTOOLS_BASE_URL;
}

function outsetaBaseUrl() {
  return cleanText(process.env.POWERTOOLS_OUTSETA_API_BASE_URL, 200).replace(/\/+$/, '') || OUTSETA_API_BASE_URL;
}

/** Accept a bare session JWT or a pasted `jwt=…; other=…` cookie string. */
function cleanSessionToken(value) {
  let raw = cleanText(value, 4096);
  const cookie = /(?:^|;\s*)jwt=([^;\s]+)/.exec(raw);
  if (cookie) raw = cookie[1];
  raw = raw.replace(/^["']|["']$/g, '');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) {
    throw httpError(400, 'Paste the Power Tools session (the jwt cookie value).', 'powertools_session_invalid');
  }
  return raw;
}

/** `jwt` from a fetch Response's Set-Cookie header(s). */
function jwtFromSetCookie(headers) {
  const list = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers?.get?.('set-cookie') || ''];
  for (const line of list) {
    const match = /(?:^|[,;]\s*)jwt=([^;,\s]+)/.exec(String(line || ''));
    if (match && match[1] && match[1] !== 'deleted') return match[1];
  }
  return '';
}

async function readJson(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function outsetaAccessToken(email, password, { fetchImpl = fetch } = {}) {
  const username = cleanText(email, 320);
  const secret = String(password ?? '');
  if (!username || !secret) {
    throw httpError(400, 'Enter your Power Tools email and password.', 'powertools_credentials_missing');
  }
  const body = new URLSearchParams();
  body.append('username', username);
  body.append('password', secret);
  const response = await fetchImpl(`${outsetaBaseUrl()}/tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw httpError(401, 'Power Tools did not accept that email and password.', 'powertools_invalid_credentials');
  }
  if (!response.ok) {
    throw httpError(502, `Power Tools sign-in is unavailable (${response.status}).`, 'powertools_login_unavailable');
  }
  if (payload?.two_factor_required || payload?.two_factor_enrollment_required) {
    throw httpError(
      409,
      'This Power Tools account uses two-factor sign-in. Paste your Power Tools session instead.',
      'powertools_two_factor',
    );
  }
  const accessToken = cleanText(payload?.access_token, 8192);
  if (!accessToken) {
    throw httpError(502, 'Power Tools sign-in returned no access token.', 'powertools_login_unavailable');
  }
  return accessToken;
}

async function exchangeAccessToken(accessToken, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    const payload = await readJson(response);
    throw httpError(
      401,
      cleanText(payload?.message, 200) || 'Power Tools has no account for that sign-in.',
      'powertools_invalid_credentials',
    );
  }
  if (!response.ok) {
    throw httpError(502, `Power Tools sign-in failed (${response.status}).`, 'powertools_login_unavailable');
  }
  const jwt = jwtFromSetCookie(response.headers);
  if (!jwt) {
    throw httpError(502, 'Power Tools sign-in returned no session.', 'powertools_login_unavailable');
  }
  return jwt;
}

/** Email + password → Power Tools session jwt (the password is not kept). */
async function loginWithPassword({ email, password }, options = {}) {
  const accessToken = await outsetaAccessToken(email, password, options);
  return exchangeAccessToken(accessToken, options);
}

async function powerToolsRequest(jwt, path, { fetchImpl = fetch } = {}) {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const response = await fetchImpl(`${baseUrl()}/api/${cleanPath}`, {
    headers: { Accept: 'application/json', Cookie: `jwt=${jwt}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw httpError(409, 'Your Power Tools session expired. Sign in to Power Tools again.', 'powertools_session_expired');
  }
  if (!response.ok) {
    throw httpError(502, `Power Tools ${cleanPath} failed (${response.status}).`, 'powertools_unavailable');
  }
  const payload = await readJson(response);
  if (payload == null) {
    throw httpError(502, `Power Tools ${cleanPath} returned no JSON.`, 'powertools_unavailable');
  }
  return payload;
}

/** Non-secret identity from GET /api/user (drops CardTrader tokens and the rest). */
function safePowerToolsUser(user = {}) {
  const ct = user?.assignedCardtraderUser && typeof user.assignedCardtraderUser === 'object'
    ? user.assignedCardtraderUser
    : null;
  return {
    userId: cleanText(user?._id, 80),
    username: cleanText(user?.username, 320),
    cardtraderUserId: ct?.cardtraderUserId == null ? '' : cleanText(ct.cardtraderUserId, 40),
    cardtraderUserName: cleanText(ct?.cardtraderUserName, 160),
  };
}

async function fetchPowerToolsUser(jwt, options = {}) {
  const user = await powerToolsRequest(jwt, 'user', options);
  const safe = safePowerToolsUser(user);
  if (!safe.userId && !safe.username) {
    throw httpError(502, 'Power Tools returned no account for that session.', 'powertools_unavailable');
  }
  return safe;
}

async function fetchPowerToolsOrders(jwt, options = {}) {
  const orders = await powerToolsRequest(jwt, 'user/order', options);
  if (!Array.isArray(orders)) {
    throw httpError(502, 'Power Tools orders did not return a list.', 'powertools_unavailable');
  }
  return orders;
}

function timestampToIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function docRef(firestore, uid) {
  return firestore.collection(COLLECTION).doc(integrationDocId(uid));
}

async function readPowerToolsDoc(firestore, uid) {
  return docRef(firestore, uid).get();
}

function safePowerToolsStatus(doc) {
  const data = doc?.exists ? doc.data() || {} : {};
  const connected = data.enabled === true && Boolean(data.encryptedSession);
  return {
    connected,
    provider: PROVIDER,
    account: connected ? data.metadata || null : null,
    connectedAt: timestampToIso(data.connectedAt),
    lastValidatedAt: timestampToIso(data.lastValidatedAt),
    disconnectedAt: timestampToIso(data.disconnectedAt),
    sessionExpiredAt: timestampToIso(data.sessionExpiredAt),
  };
}

/** Refuse more than MAX_FAILED_LOGINS failed password sign-ins per hour per Pokoin user. */
function loginThrottle(data = {}, now = Date.now()) {
  const attempts = data.loginAttempts || {};
  const start = Number(attempts.windowStartMs) || 0;
  const inWindow = now - start < LOGIN_WINDOW_MS;
  return {
    blocked: inWindow && (Number(attempts.failed) || 0) >= MAX_FAILED_LOGINS,
    next: inWindow ? { windowStartMs: start, failed: Number(attempts.failed) || 0 } : { windowStartMs: now, failed: 0 },
  };
}

async function recordFailedLogin(firestore, uid, throttleNext) {
  await docRef(firestore, uid).set(
    { uid, provider: PROVIDER, loginAttempts: { ...throttleNext, failed: throttleNext.failed + 1 } },
    { merge: true },
  );
}

async function storePowerToolsSession({ admin, firestore, uid, jwt, account }) {
  parseEncryptionKey();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = docRef(firestore, uid);
  const prior = (await ref.get())?.data?.() || {};
  await ref.set(
    {
      uid,
      provider: PROVIDER,
      enabled: true,
      metadata: account,
      encryptedSession: encryptSecret(jwt),
      connectedAt: prior.enabled === true && prior.connectedAt ? prior.connectedAt : now,
      lastValidatedAt: now,
      updatedAt: now,
      disconnectedAt: null,
      sessionExpiredAt: null,
      loginAttempts: { windowStartMs: 0, failed: 0 },
    },
    { merge: true },
  );
}

async function disconnectPowerTools({ admin, firestore, uid }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await docRef(firestore, uid).set(
    { enabled: false, encryptedSession: null, disconnectedAt: now, updatedAt: now },
    { merge: true },
  );
}

/** Session jwt for a connected seller, or '' when Power Tools is not connected. */
async function decryptPowerToolsSession(firestore, uid) {
  const doc = await readPowerToolsDoc(firestore, uid);
  const data = doc?.exists ? doc.data() || {} : {};
  if (data.enabled !== true || !data.encryptedSession) return '';
  return decryptSecret(data.encryptedSession);
}

async function markSessionExpired({ admin, firestore, uid }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await docRef(firestore, uid).set({ sessionExpiredAt: now, updatedAt: now }, { merge: true });
}

module.exports = {
  COLLECTION,
  MAX_FAILED_LOGINS,
  PROVIDER,
  cleanSessionToken,
  decryptPowerToolsSession,
  disconnectPowerTools,
  exchangeAccessToken,
  fetchPowerToolsOrders,
  fetchPowerToolsUser,
  integrationDocId,
  jwtFromSetCookie,
  loginThrottle,
  loginWithPassword,
  markSessionExpired,
  outsetaAccessToken,
  readPowerToolsDoc,
  recordFailedLogin,
  safePowerToolsStatus,
  safePowerToolsUser,
  storePowerToolsSession,
};
