export const COOKIE_CONSENT_KEY = 'pokoin.cookieConsent';
export const COOKIE_CONSENT_COOKIE = 'pokoin_cookie_consent';
export const COOKIE_BANNER_COPY =
  'We use cookies to keep you signed in, remember your cart, and run the marketplace.';

/** '1' = all cookies (Google's store badge too); 'essential' = sign-in and cart only. */
export const COOKIE_CONSENT_ALL = '1';
export const COOKIE_CONSENT_ESSENTIAL = 'essential';

const ACCEPTED = new Set(['1', 'true']);
const ANSWERED = new Set(['1', 'true', COOKIE_CONSENT_ESSENTIAL]);

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

function isAnsweredValue(value) {
  return ANSWERED.has(String(value || '').trim());
}

export function readConsentCookie(cookieSource) {
  const raw = cookieSource ?? (typeof document !== 'undefined' ? document.cookie : '');
  if (!raw) {
    return '';
  }
  const match = String(raw).match(/(?:^|;\s*)pokoin_cookie_consent=([^;]*)/);
  return match ? decodeURIComponent(match[1].trim()) : '';
}

function writeConsentCookie(value) {
  if (typeof document === 'undefined') {
    return;
  }
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_CONSENT_COOKIE}=${value}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

function storedConsent(storage, cookieSource) {
  try {
    const value = safeStorage(storage)?.getItem(COOKIE_CONSENT_KEY);
    if (isAnsweredValue(value)) {
      return String(value).trim();
    }
  } catch (_) {
    /* private mode / credentialless teardown */
  }
  return readConsentCookie(cookieSource);
}

/** The visitor answered the banner, with either button. */
export function hasCookieConsent(storage, cookieSource) {
  return isAnsweredValue(storedConsent(storage, cookieSource));
}

/** The visitor accepted all cookies, not only the essential ones (gates third-party widgets). */
export function hasFullCookieConsent(storage, cookieSource) {
  return isAcceptedValue(storedConsent(storage, cookieSource));
}

export function acceptCookieConsent(storage, level = COOKIE_CONSENT_ALL) {
  const value = level === COOKIE_CONSENT_ESSENTIAL ? COOKIE_CONSENT_ESSENTIAL : COOKIE_CONSENT_ALL;
  try {
    safeStorage(storage)?.setItem(COOKIE_CONSENT_KEY, value);
  } catch (_) {
    /* private mode / credentialless iframe */
  }
  if (storage === undefined) {
    writeConsentCookie(value);
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
