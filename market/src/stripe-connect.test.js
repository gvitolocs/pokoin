import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_CONNECT_GET_STARTED,
  friendlyStripeError,
  isPlatformConnectSetupError,
  stripeDashboardUrlForError,
} from './stripe-connect.js';

const PROFILE = 'You must complete your platform profile to use Connect and create live connected accounts. Visit your dashboard at https://dashboard.stripe.com/connect/accounts/overview to answer the questionnaire.';

test('platform profile error opens the dashboard link Stripe names', () => {
  assert.equal(isPlatformConnectSetupError(PROFILE), true);
  assert.equal(stripeDashboardUrlForError(PROFILE), 'https://dashboard.stripe.com/connect/accounts/overview');
  assert.match(friendlyStripeError(PROFILE), /platform profile/);
});

test('server dashboardUrl wins; Connect-not-enabled falls back to overview', () => {
  assert.equal(
    stripeDashboardUrlForError('x', { dashboardUrl: 'https://dashboard.stripe.com/settings/connect' }),
    'https://dashboard.stripe.com/settings/connect',
  );
  assert.equal(stripeDashboardUrlForError('x', { dashboardUrl: 'https://evil.example/' }), '');
  assert.equal(
    stripeDashboardUrlForError('Your account has not signed up for Connect.'),
    STRIPE_CONNECT_GET_STARTED,
  );
});

test('seller errors open nothing and keep their text', () => {
  assert.equal(stripeDashboardUrlForError('Choose ship-from country before Stripe Connect.'), '');
  assert.equal(friendlyStripeError('Choose ship-from country before Stripe Connect.'), 'Choose ship-from country before Stripe Connect.');
  assert.equal(friendlyStripeError(''), 'Connect failed.');
});
