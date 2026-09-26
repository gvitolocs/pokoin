import { handleMarketplaceCardOgRequest } from './marketplace-card-og.js';
import { handleMarketplaceHubOgRequest } from './marketplace-hub-og.js';
import { handleMarketplaceHomeRequest } from './marketplace-home.js';
import { fetchOriginOrWorking } from './working-page.js';

/** Inject ?game= / x-pokoin-game for satellite hosts so Oracle never defaults to Pokemon. */
export function withSatelliteMarketplaceGame(request) {
  const url = new URL(request.url);
  const host = String(url.hostname || '').toLowerCase();
  let game = '';
  if (host === 'onepiece.pokoin.com' || host.startsWith('onepiece.')) {
    game = 'one_piece';
  } else if (host === 'riftbound.pokoin.com' || host.startsWith('riftbound.')) {
    game = 'riftbound';
  }
  if (!game || !url.pathname.startsWith('/api/marketplace')) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set('x-pokoin-game', game);
  headers.set('x-pokoin-host', host);
  if (!url.searchParams.has('game')) {
    url.searchParams.set('game', game);
  }
  return new Request(url.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });
}

export function isMarketplaceDeskPath(pathname = '') {
  return /^\/marketplace\/[a-z]{2}\/cards\/[^/]+/i.test(String(pathname || ''));
}

export function isMarketplaceSellerPath(pathname = '') {
  return /^\/marketplace\/[a-z]{2}\/users\/[^/]+/i.test(String(pathname || ''));
}

const EXTENSION_ACCOUNT_PATHS = new Set([
  '/profile',
  '/auth',
  '/cart',
  '/wallet',
  '/checkout',
  '/orders',
  '/inventory',
  '/nft',
  '/buy',
]);

/** Card desks, seller pages, and account routes the side-panel iframe can open. */
export function isExtensionFramePath(pathname = '') {
  const path = String(pathname || '');
  if (isMarketplaceDeskPath(path) || isMarketplaceSellerPath(path)) {
    return true;
  }
  const stripped = path.replace(/\/$/, '') || '/';
  return EXTENSION_ACCOUNT_PATHS.has(stripped);
}

/** Fetch origin HTML without the chrome-extension iframe Referer that Bot Fight flags. */
export function originDeskRequest(request) {
  const url = new URL(request.url);
  const headers = new Headers();
  const accept = request.headers.get('Accept');
  const userAgent = request.headers.get('User-Agent');
  const language = request.headers.get('Accept-Language');
  headers.set('Accept', accept || 'text/html,application/xhtml+xml');
  if (userAgent) {
    headers.set('User-Agent', userAgent);
  }
  if (language) {
    headers.set('Accept-Language', language);
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers,
    redirect: 'follow',
  });
}

/** Pin frame-ancestors when POKOIN_EXTENSION_IDS is set; otherwise keep the side panel working. */
export function extensionFrameAncestors(env = {}) {
  const ids = String(env.POKOIN_EXTENSION_IDS || '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => /^[a-p]{32}$/.test(id));
  if (!ids.length) {
    return "frame-ancestors 'self' chrome-extension:";
  }
  return `frame-ancestors 'self' ${ids.map((id) => `chrome-extension://${id}`).join(' ')}`;
}

/** Let the Chrome extension iframe Pokoin desk pages. */
export function allowExtensionDeskFrame(response, env = {}) {
  const headers = new Headers(response.headers);
  headers.delete('X-Frame-Options');
  headers.delete('x-frame-options');
  const existing = String(headers.get('Content-Security-Policy') || '')
    .replace(/;\s*$/, '')
    .replace(/(?:^|;)\s*frame-ancestors[^;]*/ig, '')
    .replace(/^\s*;\s*/, '')
    .trim();
  const frameAncestors = extensionFrameAncestors(env);
  headers.set(
    'Content-Security-Policy',
    existing ? `${existing}; ${frameAncestors}` : frameAncestors,
  );
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('x-pokoin-extension-frame', '1');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** More-specific routes so SPA/API/assets skip the fat shortlink Worker. */
export default {
  async fetch(request, env, ctx) {
    const satelliteRequest = withSatelliteMarketplaceGame(request);
    const og = await handleMarketplaceCardOgRequest(satelliteRequest, env, ctx);
    if (og) {
      return og;
    }
    const hub = await handleMarketplaceHubOgRequest(satelliteRequest, env, ctx);
    if (hub) {
      return hub;
    }
    const home = await handleMarketplaceHomeRequest(satelliteRequest, env, ctx);
    if (home) {
      return home;
    }
    let url;
    try {
      url = new URL(satelliteRequest.url);
    } catch (_) {
      return fetchOriginOrWorking(satelliteRequest);
    }
    if (isExtensionFramePath(url.pathname)) {
      const response = await fetchOriginOrWorking(originDeskRequest(satelliteRequest), satelliteRequest);
      return allowExtensionDeskFrame(response, env);
    }
    return fetchOriginOrWorking(satelliteRequest);
  },
};
