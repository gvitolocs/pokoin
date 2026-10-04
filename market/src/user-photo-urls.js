/** Map stored chat/listing photo URLs onto the auth-aware API proxy. */

const API_ORIGIN = 'https://api.pokoin.com';

export function isUserPhotoPath(pathname) {
  return /^\/user-photos\/(chat|listing)\/[A-Za-z0-9]{8,128}\/[0-9a-f]{12,64}\.jpg$/i.test(
    String(pathname || ''),
  );
}

export function isChatPhotoUrl(value) {
  const path = userPhotoPath(value);
  return path.startsWith('/user-photos/chat/');
}

export function userPhotoPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/user-photos/')) return raw.slice('/api'.length);
  if (raw.startsWith('/user-photos/')) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith('.r2.dev') && isUserPhotoPath(url.pathname)) {
      return url.pathname;
    }
    if (
      (url.hostname === 'api.pokoin.com' || url.hostname.endsWith('.pokoin.com'))
      && url.pathname.startsWith('/api/user-photos/')
    ) {
      return url.pathname.slice('/api'.length);
    }
  } catch {
    return '';
  }
  return '';
}

export function chatPhotoDisplayUrl(value, { apiOrigin = API_ORIGIN } = {}) {
  const path = userPhotoPath(value);
  if (!path) return String(value || '').trim();
  return `${String(apiOrigin || API_ORIGIN).replace(/\/+$/, '')}/api${path}`;
}
