import { handleMarketplaceCardOgRequest } from './marketplace-card-og.js';
import { handleMarketplaceHomeRequest } from './marketplace-home.js';

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

/** More-specific routes so SPA/API/assets skip the fat shortlink Worker. */
export default {
  async fetch(request, env, ctx) {
    const satelliteRequest = withSatelliteMarketplaceGame(request);
    const og = await handleMarketplaceCardOgRequest(satelliteRequest, env, ctx);
    if (og) {
      return og;
    }
    const home = await handleMarketplaceHomeRequest(satelliteRequest, env, ctx);
    if (home) {
      return home;
    }
    return fetch(satelliteRequest);
  },
};
