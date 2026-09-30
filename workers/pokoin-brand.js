/**
 * pokoin.com/brand/* → /market/brand/* on the same origin.
 *
 * The production build serves market/public under /market/, so logo and
 * illustration files live at /market/brand/…. vercel.json has the same
 * rewrite; this Worker makes /brand/ work without waiting for a web deploy
 * (Vercel's free plan was out of deployments on 2026-09-29) and is harmless
 * once the rewrite is live.
 */
export function brandTarget(url) {
  const incoming = new URL(url);
  if (!incoming.pathname.startsWith('/brand/')) return null;
  const target = new URL(incoming);
  target.pathname = `/market${incoming.pathname}`;
  return target;
}

export default {
  async fetch(request) {
    const target = brandTarget(request.url);
    if (!target || !['GET', 'HEAD'].includes(request.method)) {
      return fetch(request);
    }
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers: request.headers,
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    const response = new Response(upstream.body, upstream);
    if (upstream.ok) response.headers.set('cache-control', 'public, max-age=3600');
    return response;
  },
};
