/**
 * Narrow edge proxy for pokoin.com. Static pages and assets are served by
 * Workers Static Assets and never enter this script.
 *
 * run_worker_first is limited to /api, card images, Firebase auth, chain RPC,
 * and the scan identify hop. Those cannot be static files: the SPA calls
 * same-origin /api so Cloudflare Bot Fight clearance still applies.
 */
import { handleMarketplaceHomeRequest } from './marketplace-home.js';
import { handleMarketplaceCardOgRequest } from './marketplace-card-og.js';
import { handleMarketplaceHubOgRequest } from './marketplace-hub-og.js';

async function proxy(request, origin, pathname) {
  const incoming = new URL(request.url);
  const target = new URL(origin);
  target.pathname = pathname;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }
  return fetch(new Request(target, init));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      const rails = await handleMarketplaceHomeRequest(request, env, ctx);
      if (rails) return rails;
      return proxy(request, 'https://api.pokoin.com', pathname);
    }
    if (pathname.startsWith('/card-images/')) {
      const rest = pathname.slice('/card-images'.length) || '/';
      return proxy(request, 'https://cdn.pokoin.com', rest);
    }
    if (pathname.startsWith('/__/auth/') || pathname.startsWith('/__/firebase/')) {
      return proxy(request, 'https://pokoin.firebaseapp.com', pathname);
    }
    if (pathname.startsWith('/chain/')) {
      return proxy(request, 'https://rpc.pokoin.com', pathname);
    }
    if (pathname === '/cardscan/identify') {
      return proxy(request, 'https://api.pokoin.com', '/api/scan/identify');
    }
    try {
      const cardHtml = await handleMarketplaceCardOgRequest(request, env, ctx);
      if (cardHtml) return cardHtml;
    } catch (_) {
      /* card API failure must not become a 5xx document */
    }
    try {
      const hubHtml = await handleMarketplaceHubOgRequest(request, env, ctx);
      if (hubHtml) return hubHtml;
    } catch (_) {
      /* hub API failure falls through to the SPA shell */
    }
    if (env?.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
