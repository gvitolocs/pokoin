import assert from 'node:assert/strict';
import test from 'node:test';
import { profileFrom } from './auth-profile.js';

test('a legacy role silver without silverUntil no longer paints Silver', () => {
  // profileFrom keeps the raw `admin || (silverUntil && ...)` result, so an
  // expired/missing silverUntil is null — falsy, never a paint.
  assert.ok(!profileFrom({ role: 'silver' }, 'u1').silver);
  assert.ok(!profileFrom({ role: 'Silver' }, 'u1').silver);
});

test('an expired silverUntil is not Silver, even with role silver', () => {
  assert.ok(!profileFrom({
    role: 'silver',
    silverUntil: '2020-01-01T00:00:00Z',
  }, 'u1').silver);
  assert.ok(!profileFrom({ silverUntil: '2020-01-01T00:00:00Z' }, 'u1').silver);
});

test('a future silverUntil is Silver', () => {
  const profile = profileFrom({ silverUntil: '2030-01-01T00:00:00Z' }, 'u1');
  assert.equal(profile.silver, true);
  assert.equal(profile.silverUntil.toISOString(), '2030-01-01T00:00:00.000Z');
});

test('a Firestore client Timestamp silverUntil is Silver', () => {
  // SDK Timestamp instance: readDate calls toDate().
  const futureSeconds = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const sdkTimestamp = {
    seconds: futureSeconds,
    nanoseconds: 514000000,
    toDate: () => new Date(futureSeconds * 1000),
  };
  assert.equal(profileFrom({ silverUntil: sdkTimestamp }, 'u1').silver, true);
  // Plain {seconds, nanoseconds} snapshot without toDate().
  assert.equal(
    profileFrom({ silverUntil: { seconds: futureSeconds, nanoseconds: 0 } }, 'u1').silver,
    true,
  );
  // And the same shapes expired stay non-Silver.
  const pastSeconds = Math.floor(Date.now() / 1000) - 60;
  assert.ok(!profileFrom({ silverUntil: { seconds: pastSeconds, nanoseconds: 0 } }, 'u1').silver);
  const expiredSdk = {
    seconds: pastSeconds,
    nanoseconds: 0,
    toDate: () => new Date(pastSeconds * 1000),
  };
  assert.ok(!profileFrom({ silverUntil: expiredSdk }, 'u2').silver);
});

test('admins stay Silver permanently without silverUntil', () => {
  assert.equal(profileFrom({ admin: true }, 'u1').silver, true);
  assert.equal(profileFrom({ isAdmin: true }, 'u1').silver, true);
  assert.equal(profileFrom({ role: 'admin' }, 'u1').silver, true);
  assert.equal(profileFrom({ roles: ['admin'] }, 'u1').silver, true);
  assert.equal(profileFrom({ admin: true }, 'u1').admin, true);
});
