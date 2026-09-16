/** Serves https://pokoin.com/download/extension.zip from R2. */
const OBJECT_KEY = 'downloads/pokemon-card-extension-12.0.21.zip';
const DOWNLOAD_NAME = 'pokemon-card-extension-12.0.21.zip';
const VERSION = '12.0.21';

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const object = await env.DOWNLOADS.get(OBJECT_KEY);
    if (!object) {
      return new Response('Extension package unavailable', { status: 503 });
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', 'application/zip');
    headers.set('Content-Disposition', `attachment; filename="${DOWNLOAD_NAME}"`);
    headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
    headers.set('ETag', object.httpEtag);
    headers.set('X-Pokoin-Extension-Version', VERSION);
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
