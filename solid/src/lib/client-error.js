import { publicApiUrl } from '@market/extension-auth-bridge.js';

/**
 * Send a route crash to `POST /api/client-error` (one journal line on the API,
 * nothing stored) and keep it in the console. text/plain + sendBeacon: no CORS
 * preflight, survives navigation. Never throws.
 */
export function reportClientError(error, signedIn = false) {
  try {
    console.error(error);
    const body = JSON.stringify({
      route: `${location.pathname}${location.search ? '?…' : ''}`,
      message: String(error?.message || error || '').slice(0, 500),
      stack: String(error?.stack || '').slice(0, 3000),
      release: document.querySelector('meta[name="pokoin-release"]')?.content || '',
      signedIn: signedIn ? 'yes' : 'no',
    });
    const url = publicApiUrl('/api/client-error');
    const blob = new Blob([body], { type: 'text/plain' });
    if (!navigator.sendBeacon?.(url, blob)) {
      fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    }
  } catch {
    /* reporting must never break the error page */
  }
}
