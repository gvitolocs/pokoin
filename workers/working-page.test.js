import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKING_MESSAGE,
  isOriginDownStatus,
  isTunnelHtml,
  fetchOriginOrWorking,
  replaceIfOriginDown,
  wantsWorkingHtml,
  workingPageHtml,
  workingPageResponse,
} from './working-page.js';

test('530 and Cloudflare 52x are origin-down; 404 and 503 JSON are not', () => {
  assert.equal(isOriginDownStatus(530), true);
  assert.equal(isOriginDownStatus(522), true);
  assert.equal(isOriginDownStatus(404), false);
  assert.equal(isOriginDownStatus(503), false);
  assert.equal(isOriginDownStatus(502), false);
});

test('tunnel HTML is the Cloudflare 1033 label, not a normal 502', () => {
  assert.equal(
    isTunnelHtml('The host is configured as a Cloudflare Tunnel, but Cloudflare is currently unable to reach it.'),
    true,
  );
  assert.equal(isTunnelHtml('error code: 1033'), true);
  assert.equal(isTunnelHtml('<p>Request failed (502)</p>'), false);
});

test('sitemaps and robots stay XML/text, not the working HTML page', () => {
  const sitemap = new Request('https://api.pokoin.com/sitemap.xml', {
    headers: { Accept: '*/*' },
  });
  const child = new Request('https://pokoin.com/sitemap-sets.xml', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
  });
  const robots = new Request('https://pokoin.com/robots.txt', {
    headers: { Accept: 'text/plain' },
  });
  assert.equal(wantsWorkingHtml(sitemap), false);
  assert.equal(wantsWorkingHtml(child), false);
  assert.equal(wantsWorkingHtml(robots), false);
});

test('browser documents get the working page; API clients get JSON', () => {
  const htmlReq = new Request('https://api.pokoin.com/', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
  });
  const apiReq = new Request('https://api.pokoin.com/api/marketplace-home', {
    headers: { Accept: 'application/json' },
  });
  assert.equal(wantsWorkingHtml(htmlReq), true);
  assert.equal(wantsWorkingHtml(apiReq), false);
  const page = workingPageHtml();
  assert.match(page, new RegExp(WORKING_MESSAGE));
  assert.match(page, /working\.gif/);
  assert.doesNotMatch(page, /Cloudflare Tunnel/i);
});

test('replaceIfOriginDown swaps 530 HTML for the working page and leaves 200 alone', async () => {
  const request = new Request('https://api.pokoin.com/', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
  });
  const down = await replaceIfOriginDown(
    request,
    new Response('The host is configured as a Cloudflare Tunnel, but Cloudflare is currently unable to reach it.', {
      status: 530,
      headers: { 'content-type': 'text/html' },
    }),
  );
  assert.equal(down.headers.get('x-pokoin-working'), '1');
  const html = await down.text();
  assert.match(html, new RegExp(WORKING_MESSAGE));
  assert.doesNotMatch(html, /Cloudflare Tunnel/i);

  const ok = new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const passed = await replaceIfOriginDown(request, ok);
  assert.equal(passed.status, 200);
  assert.equal(await passed.text(), '{"ok":true}');
});

test('API 530 becomes JSON without the tunnel sentence', async () => {
  const request = new Request('https://pokoin.com/api/marketplace-home', {
    headers: { Accept: 'application/json' },
  });
  const down = workingPageResponse(request);
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await down.json(), { error: WORKING_MESSAGE });
});

test('document 5xx uses the SPA when assets are up; a dead asset host stays 503', async () => {
  const request = new Request('https://pokoin.com/marketplace/sets/151', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
  });
  const original = globalThis.fetch;
  const assets = {
    fetch: async () => new Response('<title>151</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  };
  try {
    globalThis.fetch = async () => new Response('bad gateway', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    const soft = await fetchOriginOrWorking(request, request, { assets });
    assert.equal(soft.status, 200);
    assert.equal(soft.headers.get('x-pokoin-asset-fallback'), '1');
    assert.match(await soft.text(), /<title>151<\/title>/);

    globalThis.fetch = async () => {
      throw new Error('network');
    };
    const thrown = await fetchOriginOrWorking(request, request, { assets });
    assert.equal(thrown.status, 200);
    assert.equal(thrown.headers.get('x-pokoin-asset-fallback'), '1');

    const outage = await fetchOriginOrWorking(request, request, {
      assets: { fetch: async () => new Response('no', { status: 503 }) },
    });
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get('x-pokoin-working'), '1');
  } finally {
    globalThis.fetch = original;
  }
});
