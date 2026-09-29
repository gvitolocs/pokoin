// Stripe Connect onboarding errors that need the platform owner to act in the
// Stripe Dashboard (enable Connect, finish the platform profile questionnaire).

/** Connect → Accounts overview, where Stripe asks for the platform setup. */
export const STRIPE_CONNECT_GET_STARTED = 'https://dashboard.stripe.com/connect/accounts/overview';

const PLATFORM_SETUP = /signed up for Connect|Connect is not enabled|complete your platform profile/i;

export function isPlatformConnectSetupError(message) {
  return PLATFORM_SETUP.test(String(message || ''));
}

/**
 * Stripe Dashboard page that fixes this onboarding error, or '' when it is not
 * a platform setup problem. Prefers the server's dashboardUrl, then a Stripe
 * Dashboard link inside Stripe's own message.
 */
export function stripeDashboardUrlForError(message, body = null) {
  const fromServer = String(body?.dashboardUrl || '');
  if (/^https:\/\/dashboard\.stripe\.com\//.test(fromServer)) return fromServer;
  const text = String(message || '');
  const inText = text.match(/https:\/\/dashboard\.stripe\.com\/[^\s"'<>]*[^\s"'<>.,;:)]/);
  if (inText) return inText[0];
  return isPlatformConnectSetupError(text) ? STRIPE_CONNECT_GET_STARTED : '';
}

export function friendlyStripeError(message) {
  const text = String(message || '');
  if (/complete your platform profile/i.test(text)) {
    return 'Stripe needs the Pokoin platform profile finished before sellers can connect. The Stripe Connect questionnaire opened in a new tab — complete it, then try again.';
  }
  if (isPlatformConnectSetupError(text)) {
    return 'Stripe Connect is not enabled on the Pokoin platform account yet. Stripe Connect setup opened in a new tab — finish it, then try again.';
  }
  return text || 'Connect failed.';
}
