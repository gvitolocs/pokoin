import idsBin from './card-ids.bin';
import startsBin from './card-starts.bin';
import blobGz from './card-slug-blob.gz';
import {
  canonicalRedirectUrl,
  shortlinkCardId,
  slugFromPackedIndex,
  u32View,
} from './shortlink-path.js';

const SITE = 'https://pokoin.com';
const REDIRECT_CACHE_CONTROL =
  'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800';

const ids = u32View(idsBin);
const starts = u32View(startsBin);
let blobPromise;

function slugBlob() {
  blobPromise ||= new Response(
    new Response(blobGz).body.pipeThrough(new DecompressionStream('gzip')),
  ).text();
  return blobPromise;
}

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
    const blob = await slugBlob();
    const slug = slugFromPackedIndex(cardId, ids, starts, blob);
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
