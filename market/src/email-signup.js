// Pure helpers for the email/password registration state machine:
// NEW -> PENDING_EMAIL_VERIFICATION -> VERIFIED -> ACTIVE.
// The backend (api/register-email.js + api/verify-email-signup.js on
// api.pokoin.com) owns the states; Auth.jsx renders them.

export const RESEND_COOLDOWN_MS = 60 * 1000;

// Firebase codes that mean "no active account for these credentials". A
// pending email signup has no Firebase identity yet, so those codes are the
// signal to probe the backend for a pending verification.
const PENDING_LOGIN_CODES = new Set([
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/user-not-found',
  'auth/wrong-password',
]);

export function signupTokenFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const token = String(params.get('signupToken') || '').trim();
  return token || null;
}

export function isNativeVerifiedReturn(search) {
  return new URLSearchParams(search || '').get('verified') === '1';
}

export function isPendingLoginError(code) {
  return PENDING_LOGIN_CODES.has(String(code || ''));
}

export function classifyVerifyError(error) {
  const code = String(error?.body?.code || '');
  const message = error?.message || 'Email verification failed.';
  if (code === 'expired_token') {
    return { kind: 'expired', message };
  }
  if (code === 'already_verified') {
    return { kind: 'already_verified', message };
  }
  if (code === 'invalid_token') {
    return { kind: 'invalid', message };
  }
  return { kind: 'generic', message };
}

export function resendCooldownRemainingMs(lastSentAtMs, nowMs = Date.now()) {
  return Math.max(0, RESEND_COOLDOWN_MS - (nowMs - lastSentAtMs));
}

const AUTH_ERROR_TEXT = Object.freeze({
  'auth/network-request-failed': 'Could not reach the sign-in service. Check your connection and try again.',
  'auth/invalid-credential': 'Email or password is not right.',
  'auth/invalid-login-credentials': 'Email or password is not right.',
  'auth/wrong-password': 'Email or password is not right.',
  'auth/user-not-found': 'Email or password is not right.',
  'auth/invalid-email': 'That email address does not look right.',
  'auth/missing-password': 'Enter your password.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Choose a password with at least 6 characters.',
  'auth/user-disabled': 'This account is disabled. Write to contact@pokoin.com.',
  'auth/popup-closed-by-user': 'The Google window was closed before sign-in finished.',
  'auth/cancelled-popup-request': 'The Google window was closed before sign-in finished.',
  'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups and try again.',
});

/**
 * Words a person can act on for a sign-in failure. Firebase's own text
 * ("Firebase: Error (auth/network-request-failed).") never reaches the page;
 * our API's messages pass through unchanged.
 */
export function authErrorMessage(error, fallback = 'Sign in failed.') {
  const raw = String(error?.message || '');
  const code = String(error?.code || raw.match(/\((auth\/[a-z-]+)\)/)?.[1] || '');
  if (AUTH_ERROR_TEXT[code]) return AUTH_ERROR_TEXT[code];
  if (!raw || /^Firebase\b/i.test(raw) || code.startsWith('auth/')) return fallback;
  return raw;
}
