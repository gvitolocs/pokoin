import { GAMES } from '../market/src/game.js';
import { handleMarketplaceCardOgRequest } from './marketplace-card-og.js';
import { handleMarketplaceHubOgRequest } from './marketplace-hub-og.js';
import { handleMarketplaceHomeRequest } from './marketplace-home.js';
import { fetchOriginOrWorking } from './working-page.js';

const GAME_SLUG_RE = Object.values(GAMES).map((game) => game.slug).filter(Boolean).join('|');
const GAME_PREFIX_RE = GAME_SLUG_RE ? `(?:(?:${GAME_SLUG_RE})/)?` : '';
const DESK_LANG_RE = '[a-z]{2,3}(?:-[a-z]{2})?';

const SATELLITE_HOSTS = {
  'onepiece.pokoin.com': { slug: 'one-piece', game: 'one_piece' },
  'riftbound.pokoin.com': { slug: 'riftbound', game: 'riftbound' },
};

/** Old game subdomains move to pokoin.com/{slug}. */
export function satelliteHostRedirect(url) {
  const host = String(url.hostname || '').toLowerCase();
  const hit = SATELLITE_HOSTS[host] || (host.startsWith('onepiece.') ? SATELLITE_HOSTS['onepiece.pokoin.com'] : null)
    || (host.startsWith('riftbound.') ? SATELLITE_HOSTS['riftbound.pokoin.com'] : null);
  if (!hit) return null;
  if (url.pathname.startsWith('/api/')) {
    const dest = new URL(`${url.pathname}${url.search}`, 'https://pokoin.com');
    if (!dest.searchParams.has('game')) dest.searchParams.set('game', hit.game);
    return dest;
  }
  const path = url.pathname === '/' ? '/marketplace' : url.pathname;
  return new URL(`https://pokoin.com/${hit.slug}${path}${url.search}`);
}

/** Inject ?game= / x-pokoin-game for satellite hosts so the API never defaults to Pokemon. */
export function withSatelliteMarketplaceGame(request) {
  const url = new URL(request.url);
  const redirected = satelliteHostRedirect(url);
  if (redirected && url.pathname.startsWith('/api/')) {
    const headers = new Headers(request.headers);
    headers.set('x-pokoin-game', redirected.searchParams.get('game') || '');
    headers.set('x-pokoin-host', url.hostname);
    return new Request(redirected.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: request.redirect,
    });
  }
  return request;
}

export function isMarketplaceDeskPath(pathname = '') {
  return new RegExp(
    `^/${GAME_PREFIX_RE}marketplace/${DESK_LANG_RE}/cards/[^/]+`,
    'i',
  ).test(String(pathname || ''));
}

export function isMarketplaceSellerPath(pathname = '') {
  return new RegExp(
    `^/${GAME_PREFIX_RE}marketplace/${DESK_LANG_RE}/users/[^/]+`,
    'i',
  ).test(String(pathname || ''));
}

const EXTENSION_ACCOUNT_PATHS = new Set([
  '/profile',
  '/auth',
  '/cart',
  '/wallet',
  '/checkout',
  '/orders',
  '/inventory',
  '/mypokoin',
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
  if (stripped === '/mypokoin' || stripped.startsWith('/mypokoin/')) {
    return true;
  }
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

/** /auth stays out of the index even when the SPA shell is served from assets. */
export function withAuthRobots(response, pathname = '') {
  const path = String(pathname || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
  if (path !== '/auth') return response;
  if (!response) return response;
  const headers = new Headers(response.headers);
  headers.set('x-robots-tag', 'noindex, nofollow');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function safeHandler(fn) {
  try {
    return await fn();
  } catch (_) {
    return null;
  }
}

/** More-specific routes so SPA/API/assets skip the fat shortlink Worker. */
export default {
  async fetch(request, env, ctx) {
    try {
      const incoming = new URL(request.url);
      const dest = satelliteHostRedirect(incoming);
      if (dest) {
        return Response.redirect(dest.toString(), 301);
      }
    } catch (_) {
      /* fall through */
    }
    const satelliteRequest = withSatelliteMarketplaceGame(request);
    const og = await safeHandler(() => handleMarketplaceCardOgRequest(satelliteRequest, env, ctx));
    if (og) return og;
    const hub = await safeHandler(() => handleMarketplaceHubOgRequest(satelliteRequest, env, ctx));
    if (hub) return hub;
    const home = await safeHandler(() => handleMarketplaceHomeRequest(satelliteRequest, env, ctx));
    if (home) return home;
    const assets = env?.ASSETS;
    let url;
    try {
      url = new URL(satelliteRequest.url);
    } catch (_) {
      return fetchOriginOrWorking(satelliteRequest, satelliteRequest, { assets });
    }
    let response;
    if (isExtensionFramePath(url.pathname)) {
      response = allowExtensionDeskFrame(
        await fetchOriginOrWorking(originDeskRequest(satelliteRequest), satelliteRequest, { assets }),
        env,
      );
    } else {
      response = await fetchOriginOrWorking(satelliteRequest, satelliteRequest, { assets });
    }
    return withAuthRobots(response, url.pathname);
  },
};
