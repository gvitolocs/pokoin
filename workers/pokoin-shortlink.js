import { lookupSlug } from './shortlink-lookup.js';
import { canonicalRedirectUrl, shortlinkCardId } from './shortlink-path.js';

const SITE = 'https://pokoin.com';
const REDIRECT_CACHE_CONTROL =
  'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';

function redirectTo(url, via) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      'Cache-Control': REDIRECT_CACHE_CONTROL,
      'Cloudflare-CDN-Cache-Control': 'max-age=86400, stale-while-revalidate=604800',
      'Cache-Tag': 'pokoin-shortlink',
      'x-pokoin-shortlink': via,
    },
  });
}

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fetch(request);
    }
    const cardId = shortlinkCardId(new URL(request.url).pathname);
    if (!cardId) {
      return fetch(request);
    }
    const slug = lookupSlug(cardId);
    if (!slug) {
      return new Response('Not found', {
        status: 404,
        headers: {
          'Cache-Control': 'private, no-store',
          'x-pokoin-shortlink': 'unknown',
        },
      });
    }
    const dest = canonicalRedirectUrl(`/marketplace/en/cards/${cardId}/${slug}`, SITE);
    if (!dest) {
      return fetch(request);
    }
    return redirectTo(dest, 'map');
  },
};
