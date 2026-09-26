/** Chrome extension token bridge. Keep postMessage shapes in sync with
 * pokemon-card-extension `pokoin-auth-bridge.js`. */

export const EXTENSION_AUTH_PATH = '/extension/auth-bridge';
export const EXTENSION_AUTH_REQUEST = 'POKOIN_EXTENSION_AUTH_TOKEN_REQUEST';
export const EXTENSION_AUTH_TOKEN = 'pokoin-auth-token';
export const EXTENSION_DESK_SESSION = 'POKOIN_EXTENSION_DESK_SESSION';
export const EXTENSION_DESK_SESSION_REQUEST = 'POKOIN_EXTENSION_DESK_SESSION_REQUEST';

export function isExtensionAuthRequest(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.type === EXTENSION_AUTH_REQUEST
    && data.source === 'pokemon-card-extension',
  );
}

export function isExtensionDeskSession(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.type === EXTENSION_DESK_SESSION
    && data.source === 'pokemon-card-extension'
    && typeof data.token === 'string'
    && data.token.length > 20
    && String(data.uid || '').trim(),
  );
}

/** Accept an injected desk token only from this frame's parent extension. */
export function isTrustedDeskSessionEvent(event, win = typeof window === 'undefined' ? undefined : window) {
  const origin = String(event?.origin || '');
  if (origin.startsWith('chrome-extension://')) {
    const ancestors = win?.location?.ancestorOrigins;
    const parentOrigin = ancestors && ancestors.length ? String(ancestors[0] || '') : '';
    return parentOrigin === origin;
  }
  try {
    return Boolean(win?.location) && origin === win.location.origin;
  } catch (_) {
    return false;
  }
}

export function isExtensionDeskSessionRequest(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.type === EXTENSION_DESK_SESSION_REQUEST
    && data.source === 'pokoin-web',
  );
}

/** True when this SPA is the credentialless desk inside the Chrome side panel. */
export function framedByChromeExtension(win = typeof window === 'undefined' ? undefined : window) {
  if (!win) {
    return false;
  }
  try {
    const search = String(win.location?.search || '');
    if (new URLSearchParams(search).get('pokoin_embed') === '1') {
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (win.credentialless === true) {
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  const ancestors = win.location?.ancestorOrigins;
  if (ancestors && ancestors.length) {
    return String(ancestors[0] || '').startsWith('chrome-extension:');
  }
  try {
    if (win.self && win.top && win.self !== win.top) {
      const referrer = String(win.document?.referrer || '');
      return !referrer || referrer.startsWith('chrome-extension:');
    }
    return false;
  } catch (_) {
    return true;
  }
}

export const PUBLIC_API_ORIGIN = 'https://api.pokoin.com';

/** Apex /api is Bot Fight. The credentialless iframe has no cf_clearance. */
export function publicApiUrl(path, win) {
  const raw = String(path || '');
  if (!raw.startsWith('/api')) {
    return raw;
  }
  if (!framedByChromeExtension(win)) {
    return raw;
  }
  return `${PUBLIC_API_ORIGIN}${raw}`;
}

export function extensionAuthTokenPayload(user, accessToken, extra = {}) {
  const token = String(accessToken || '').trim();
  if (token.length < 20) {
    return null;
  }
  return {
    type: EXTENSION_AUTH_TOKEN,
    ok: true,
    token: {
      accessToken: token,
      expiresAt: extra.expiresAt || extra.expirationTime || null,
      issuedAt: extra.issuedAt || null,
      uid: user?.uid || extra.uid || '',
      email: user?.email || extra.email || '',
    },
  };
}
