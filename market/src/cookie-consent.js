export const COOKIE_CONSENT_KEY = 'pokoin.cookieConsent';
export const COOKIE_CONSENT_COOKIE = 'pokoin_cookie_consent';
export const COOKIE_BANNER_COPY =
  'We use cookies to keep you signed in, remember your cart, and run the marketplace.';

const ACCEPTED = new Set(['1', 'true']);

function safeStorage(override) {
  if (override) {
    return override;
  }
  try {
    return globalThis.localStorage;
  } catch (_) {
    return null;
  }
}

function isAcceptedValue(value) {
  return ACCEPTED.has(String(value || '').trim());
}

export function readConsentCookie(cookieSource) {
  const raw = cookieSource ?? (typeof document !== 'undefined' ? document.cookie : '');
  if (!raw) {
    return '';
  }
  const match = String(raw).match(/(?:^|;\s*)pokoin_cookie_consent=([^;]*)/);
  return match ? decodeURIComponent(match[1].trim()) : '';
}

function writeConsentCookie() {
  if (typeof document === 'undefined') {
    return;
  }
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_CONSENT_COOKIE}=1; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

export function hasCookieConsent(storage, cookieSource) {
  try {
    const value = safeStorage(storage)?.getItem(COOKIE_CONSENT_KEY);
    if (isAcceptedValue(value)) {
      return true;
    }
  } catch (_) {
    /* private mode / credentialless teardown */
  }
  return isAcceptedValue(readConsentCookie(cookieSource));
}

export function acceptCookieConsent(storage) {
  try {
    safeStorage(storage)?.setItem(COOKIE_CONSENT_KEY, '1');
  } catch (_) {
    /* private mode / credentialless iframe */
  }
  if (storage === undefined) {
    writeConsentCookie();
  }
}

/** Credentialless extension iframes wipe storage on reload. Do not nag there. */
export function isEmbeddedMarketplace(win = globalThis) {
  try {
    if (!win) {
      return false;
    }
    if (win.credentialless === true) {
      return true;
    }
    return Boolean(win.self && win.top && win.self !== win.top);
  } catch (_) {
    return true;
  }
}

export function shouldShowCookieBanner(storage, win = globalThis, cookieSource) {
  if (isEmbeddedMarketplace(win)) {
    return false;
  }
  return !hasCookieConsent(storage, cookieSource);
}
