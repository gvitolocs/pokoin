/** Google OAuth cannot complete inside the extension side-panel iframe. */

export function isAuthFramed(win = globalThis) {
  try {
    return Boolean(win && win.self !== win.top);
  } catch {
    return true;
  }
}

export function googleAuthPopupFailed(error) {
  const code = String(error?.code || '');
  return code === 'auth/popup-blocked'
    || code === 'auth/cancelled-popup-request'
    || /popup-blocked|popup was blocked/i.test(String(error?.message || ''));
}

export function topLevelLoginUrl(origin, fromPath = '/profile') {
  const from = String(fromPath || '/profile');
  const safeFrom = from.startsWith('/') ? from : '/profile';
  const params = new URLSearchParams({ from: safeFrom });
  return `${String(origin || '').replace(/\/$/, '')}/login?${params}`;
}
