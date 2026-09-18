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
