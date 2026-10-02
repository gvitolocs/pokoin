const { verifyBearerToken } = require('./_firebase');

// Operator emails. Matched only against the verified email on the Firebase
// ID token: display names and profile usernames are user-editable
// (updateProfile / users doc), so they never grant access.
const ALLOWED_EMAILS = new Set([
  'vitologiuseppe17@gmail.com',
  'pokoinpos@gmail.com',
]);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function configuredIdentifiers() {
  return [
    process.env.MARKETPLACE_ADMIN_EMAILS || '',
    process.env.MARKETPLACE_DEBUG_EMAILS || '',
    process.env.ADMIN_SIGNUP_EMAIL || '',
  ]
    .join(',')
    .split(',')
    .map(normalize)
    .filter(Boolean);
}

function hasAdminAccess(profile) {
  const role = normalize(profile?.role);
  return profile?.admin === true ||
    profile?.isAdmin === true ||
    profile?.hasAdminAccess === true ||
    role === 'admin';
}

function verifiedEmail(decoded) {
  return decoded?.email_verified === true ? normalize(decoded.email) : '';
}

async function authorizeSearchDebugRequest(req) {
  const decoded = await verifyBearerToken(req);
  const uid = decoded.uid;
  const email = normalize(decoded.email);
  const trustedEmail = verifiedEmail(decoded);
  let username = normalize(decoded.name);
  if (
    (trustedEmail && (ALLOWED_EMAILS.has(trustedEmail) || configuredIdentifiers().includes(trustedEmail))) ||
    hasAdminAccess(decoded)
  ) {
    return { uid, email, username };
  }
  const error = new Error('Search debug is not enabled for this account.');
  error.statusCode = 403;
  throw error;
}

module.exports = {
  authorizeSearchDebugRequest,
  _test: {
    configuredIdentifiers,
    hasAdminAccess,
    verifiedEmail,
  },
};
