const admin = require('firebase-admin');

function getFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin env vars are missing.');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    storageBucket,
  });

  return admin;
}

// Email/password identities are only "active" once the address is verified and
// the signup is finalized (see verify-email-signup.js). Google and wallet
// identities keep their existing eligibility semantics: sign_in_provider
// 'google.com' and 'custom' (wallet custom tokens) are always allowed here, and
// an unknown/missing provider is allowed so no other auth path can be locked
// out by this guard.
function passwordAccountRequiresVerification(decoded) {
  const provider = decoded?.firebase?.sign_in_provider;
  if (provider !== 'password') {
    return false;
  }
  return decoded?.email_verified !== true && decoded?.pok_email_verified !== true;
}

function assertActivePasswordAccount(decoded, { requireVerified }) {
  if (!requireVerified || !passwordAccountRequiresVerification(decoded)) {
    return;
  }
  throw Object.assign(
    new Error('Verify your email address to continue.'),
    { statusCode: 403, code: 'auth/pokoin-email-not-verified' },
  );
}

function markAuthFailure(req) {
  try {
    if (!req) return;
    req.pokoinAuthFailure = true;
    if (req.pokoinResponse && typeof req.pokoinResponse === 'object') {
      req.pokoinResponse.pokoinAuthFailure = true;
    }
  } catch (_) {
    // Never throw from an auth helper.
  }
}

const JWT_LIKE_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;

function redactJwtForLog(text) {
  return String(text == null ? '' : text)
    .replace(JWT_LIKE_PATTERN, '[jwt]')
    .slice(0, 80);
}

function requestLogPath(req) {
  const raw = String(req?.url || '');
  const queryIndex = raw.indexOf('?');
  return queryIndex === -1 ? raw : raw.slice(0, queryIndex);
}

async function verifyBearerToken(req, { verifyIdToken } = {}) {
  const token = bearerTokenFromRequest(req);
  if (!token) {
    markAuthFailure(req);
    const error = new Error('Missing Pokoin bearer token.');
    error.statusCode = 401;
    error.code = 'auth/missing-token';
    throw error;
  }
  const verifier = verifyIdToken || ((candidate) => getFirebaseAdmin().auth().verifyIdToken(candidate));
  let decoded;
  try {
    decoded = await verifier(token);
  } catch (error) {
    const firebaseCode = error && error.code != null ? String(error.code) : '';
    const isAuthError = firebaseCode.startsWith('auth/') && firebaseCode !== 'auth/internal-error';
    let status;
    let code;
    let message;
    if (isAuthError) {
      status = 401;
      code = 'auth/invalid-token';
      message = 'Invalid or expired sign-in token.';
    } else {
      status = 503;
      code = 'auth/unavailable';
      message = 'Sign-in could not be checked right now.';
    }
    if (isAuthError) markAuthFailure(req);
    console.warn('pokoin auth token rejected', {
      code: firebaseCode || 'none',
      status,
      reason: redactJwtForLog(error && error.message),
      method: req?.method,
      path: requestLogPath(req),
    });
    const wrapped = new Error(message);
    wrapped.statusCode = status;
    wrapped.code = code;
    throw wrapped;
  }
  // Off until the legacy-password-user backfill ran (scripts/backfill-password-email-verification.js).
  assertActivePasswordAccount(decoded, {
    requireVerified: process.env.POKOIN_REQUIRE_VERIFIED_PASSWORD === '1',
  });
  return decoded;
}

function requestHeader(req, name) {
  const headers = req?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(String(name).toLowerCase()) || '';
  }
  const direct = headers[name] ?? headers[String(name).toLowerCase()];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct[0] || '' : String(direct);
  }
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === target);
  if (!key) return '';
  const value = headers[key];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

function bearerTokenFromRequest(req) {
  const header = requestHeader(req, 'authorization');
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function authErrorResponse(error, fallback = 'Pokoin authentication failed.') {
  const statusCode = error.statusCode || 401;
  let message = error.message || fallback;
  if (statusCode === 401 && error.code !== 'auth/missing-token') {
    message = 'Invalid or expired sign-in token.';
  }
  return {
    statusCode,
    body: {
      error: message,
    },
  };
}

module.exports = {
  assertActivePasswordAccount,
  authErrorResponse,
  bearerTokenFromRequest,
  getFirebaseAdmin,
  passwordAccountRequiresVerification,
  requestHeader,
  verifyBearerToken,
};
