import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEND_COOLDOWN_MS,
  classifyVerifyError,
  isNativeVerifiedReturn,
  isPendingLoginError,
  resendCooldownRemainingMs,
  signupTokenFromSearch,
} from './email-signup.js';

test('signupTokenFromSearch reads the verification link token', () => {
  assert.equal(
    signupTokenFromSearch('?signupToken=abc123&from=%2Fprofile'),
    'abc123',
  );
  assert.equal(signupTokenFromSearch('?from=%2Fprofile'), null);
  assert.equal(signupTokenFromSearch('?signupToken='), null);
  assert.equal(signupTokenFromSearch(''), null);
  assert.equal(signupTokenFromSearch(undefined), null);
});

test('isNativeVerifiedReturn detects the Firebase action-code return', () => {
  assert.equal(isNativeVerifiedReturn('?verified=1'), true);
  assert.equal(isNativeVerifiedReturn('?verified=0'), false);
  assert.equal(isNativeVerifiedReturn(''), false);
});

test('pending login failures are exactly the no-active-account codes', () => {
  assert.equal(isPendingLoginError('auth/invalid-credential'), true);
  assert.equal(isPendingLoginError('auth/invalid-login-credentials'), true);
  assert.equal(isPendingLoginError('auth/user-not-found'), true);
  assert.equal(isPendingLoginError('auth/wrong-password'), true);
  assert.equal(isPendingLoginError('auth/popup-blocked'), false, 'Google popup failures are not pending signups');
  assert.equal(isPendingLoginError('auth/too-many-requests'), false);
  assert.equal(isPendingLoginError(''), false);
  assert.equal(isPendingLoginError(undefined), false);
});

test('verify callback errors classify by backend code', () => {
  assert.deepEqual(
    classifyVerifyError({ message: 'link expired', body: { code: 'expired_token' } }),
    { kind: 'expired', message: 'link expired' },
  );
  assert.deepEqual(
    classifyVerifyError({ message: 'already used', body: { code: 'already_verified' } }),
    { kind: 'already_verified', message: 'already used' },
  );
  assert.deepEqual(
    classifyVerifyError({ message: 'bad link', body: { code: 'invalid_token' } }),
    { kind: 'invalid', message: 'bad link' },
  );
  assert.deepEqual(
    classifyVerifyError({ message: 'Request failed (500)', body: {} }),
    { kind: 'generic', message: 'Request failed (500)' },
  );
  assert.deepEqual(
    classifyVerifyError(new Error('network down')),
    { kind: 'generic', message: 'network down' },
  );
  assert.deepEqual(classifyVerifyError(undefined), { kind: 'generic', message: 'Email verification failed.' });
});

test('resend cooldown never goes negative', () => {
  const now = 1_000_000;
  assert.equal(resendCooldownRemainingMs(now, now), RESEND_COOLDOWN_MS);
  assert.equal(resendCooldownRemainingMs(now - 10_000, now), RESEND_COOLDOWN_MS - 10_000);
  assert.equal(resendCooldownRemainingMs(now - RESEND_COOLDOWN_MS, now), 0);
  assert.equal(resendCooldownRemainingMs(now - 10 * RESEND_COOLDOWN_MS, now), 0);
});
