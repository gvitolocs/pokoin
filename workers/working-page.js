/** Branded downtime page. Never leak Cloudflare Tunnel / 1033 copy. */

export const WORKING_MESSAGE = 'We are working on a solution.';
export const WORKING_GIF_URL = 'https://pokoin.com/home/working.gif';
export const TUNNEL_RE = /cloudflare tunnel|error code:\s*1033|unable to reach it/i;

export function isOriginDownStatus(status) {
  const code = Number(status);
  return code === 530 || (code >= 520 && code <= 527);
}

export function isTunnelHtml(text) {
  return TUNNEL_RE.test(String(text || ''));
}

export function wantsWorkingHtml(request) {
  let pathname = '/';
  try {
    pathname = new URL(request.url).pathname || '/';
  } catch (_) {
    pathname = '/';
  }
  if (
    pathname.startsWith('/api/')
    || pathname === '/healthz'
    || pathname === '/health'
    || pathname === '/robots.txt'
    || pathname === '/sitemap.xml'
    || /^\/sitemap-[a-z0-9-]+\.xml$/i.test(pathname)
  ) {
    return false;
  }
  if (/\.(jpg|jpeg|png|webp|gif|svg|ico|woff2?|js|css|json|map|xml)(\?|$)/i.test(pathname)) {
    return false;
  }
  const dest = String(request.headers.get('Sec-Fetch-Dest') || '').toLowerCase();
  if (dest === 'document' || dest === 'iframe' || dest === 'embed' || dest === 'frame') {
    return true;
  }
  const accept = String(request.headers.get('Accept') || '');
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return false;
  }
  if (accept.includes('image/') && !accept.includes('text/html')) {
    return false;
  }
  return accept.includes('text/html') || dest === '' || dest === 'empty';
}

export function workingPageHtml({ gifUrl = WORKING_GIF_URL } = {}) {
  const gif = String(gifUrl || WORKING_GIF_URL);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${WORKING_MESSAGE} · Pokoin</title>
  <meta name="robots" content="noindex">
  <style>
    html, body { margin: 0; min-height: 100%; background: #000; color: #fff;
      font-family: Satoshi, ui-sans-serif, system-ui, sans-serif; }
    main { min-height: 100vh; min-height: 100dvh; display: grid; place-content: center;
      justify-items: center; gap: 1.35rem; padding: 2rem; text-align: center; }
    img { width: 160px; height: 160px; object-fit: contain; image-rendering: pixelated; }
    h1 { margin: 0; font-size: 1.55rem; font-weight: 600; letter-spacing: -0.02em; }
    p { margin: 0; color: #9d9aa4; font-size: 0.95rem; }
  </style>
</head>
<body>
  <main role="status">
    <img src="${gif}" alt="" width="160" height="160">
    <h1>${WORKING_MESSAGE}</h1>
    <p>Pokoin</p>
  </main>
</body>
</html>`;
}

export function workingPageResponse(request, { gifUrl = WORKING_GIF_URL } = {}) {
  if (wantsWorkingHtml(request)) {
    return new Response(workingPageHtml({ gifUrl }), {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-pokoin-working': '1',
      },
    });
  }
  return new Response(JSON.stringify({ error: WORKING_MESSAGE }), {
    status: 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-pokoin-working': '1',
    },
  });
}

export async function replaceIfOriginDown(request, response) {
  if (!response) {
    return workingPageResponse(request);
  }
  if (isOriginDownStatus(response.status)) {
    return workingPageResponse(request);
  }
  const type = String(response.headers.get('content-type') || '');
  if ((response.status === 502 || response.status === 503) && type.includes('text/html')) {
    const text = await response.clone().text();
    if (isTunnelHtml(text)) {
      return workingPageResponse(request);
    }
  }
  return response;
}

export async function fetchOriginOrWorking(request, pageRequest = request) {
  let response;
  try {
    response = await fetch(request);
  } catch (_) {
    return workingPageResponse(pageRequest);
  }
  return replaceIfOriginDown(pageRequest, response);
}
