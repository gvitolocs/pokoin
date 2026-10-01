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

async function verifyBearerToken(req) {
  const token = bearerTokenFromRequest(req);
  if (!token) {
    const error = new Error('Missing Pokoin bearer token.');
    error.statusCode = 401;
    throw error;
  }
  const decoded = await getFirebaseAdmin().auth().verifyIdToken(token);
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
  return {
    statusCode: error.statusCode || 401,
    body: {
      error: error.message || fallback,
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
