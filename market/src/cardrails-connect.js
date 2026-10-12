/**
 * Card Rails sign-in ("/connect/cardrails", solid/src/pages/ConnectCardRails.jsx):
 * pure parameter validation and deep-link building for "Sign in with Pokoin".
 *
 * The Card Rails apps (com.pokoin.cardrails) open this page in the system
 * browser with ?state=&code_challenge=&code_challenge_method=S256, the
 * signed-in user taps consent, and the minted one-time code redirects back to
 * cardrails://auth/pokoin. The same rules are enforced again by
 * POST /api/cardrails-authorize; this module only decides what the page shows.
 */

export const CARDRAILS_REDIRECT_BASE = 'cardrails://auth/pokoin';

/** ^[A-Za-z0-9_-]{16,128}$ */
export function isCardRailsState(value) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(String(value ?? ''));
}

/** ^[A-Za-z0-9_-]{43}$ — base64url of 32 SHA-256 bytes, no padding. */
export function isCardRailsCodeChallenge(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(value ?? ''));
}

/** Only S256 is spoken; plain is never accepted. */
export function isCardRailsCodeChallengeMethod(value) {
  return value === 'S256';
}

/** The exact query names the Card Rails app sends. */
export function parseCardRailsParams(params) {
  const search = typeof params === 'string' ? new URLSearchParams(params) : params;
  return {
    state: search.get('state') || '',
    codeChallenge: search.get('code_challenge') || '',
    codeChallengeMethod: search.get('code_challenge_method') || '',
  };
}

/** True when the app's query would reach the authorize API unchanged. */
export function isCardRailsParamsValid(params) {
  const { state, codeChallenge, codeChallengeMethod } = parseCardRailsParams(params);
  return isCardRailsState(state)
    && isCardRailsCodeChallenge(codeChallenge)
    && isCardRailsCodeChallengeMethod(codeChallengeMethod);
}

/** `cardrails://auth/pokoin?code=<code>&state=<state>`, values URL-encoded. */
export function cardRailsRedirectUrl(code, state) {
  return `${CARDRAILS_REDIRECT_BASE}?code=${encodeURIComponent(String(code ?? ''))}&state=${encodeURIComponent(String(state ?? ''))}`;
}

/** `cardrails://auth/pokoin?error=access_denied&state=<state>`. */
export function cardRailsCancelUrl(state) {
  return `${CARDRAILS_REDIRECT_BASE}?error=access_denied&state=${encodeURIComponent(String(state ?? ''))}`;
}

/** The return target after the site's normal sign-in: this exact URL. */
export function cardRailsAuthFrom(pathWithQuery) {
  return `/auth?from=${encodeURIComponent(pathWithQuery || '/connect/cardrails')}`;
}
