import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, summarizeJourney } from './stats.mjs';
import { computeInp, longTaskStats, frameStats } from './observers.mjs';
import { summarizeNetwork } from './cdp.mjs';

test('percentile interpolates like numpy linear', () => {
  const sorted = [10, 20, 30, 40];
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 50), 25);
  assert.equal(percentile(sorted, 100), 40);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
});

test('summarize counts nulls and rounds', () => {
  const s = summarize([3, null, 1, 2, undefined, NaN]);
  assert.equal(s.n, 3);
  assert.equal(s.nulls, 3);
  assert.equal(s.min, 1);
  assert.equal(s.p50, 2);
  assert.equal(s.max, 3);
  assert.equal(s.mean, 2);
  assert.equal(summarize([null]).p50, null);
});

test('summarizeJourney pools arrays and skips failed runs', () => {
  const out = summarizeJourney([
    { ok: true, metrics: { inp: 100, 'keys.toRowsMs': [10, 20, null] } },
    { ok: true, metrics: { inp: 300, 'keys.toRowsMs': [30] } },
    { ok: false, metrics: { inp: 9999 } },
  ]);
  assert.equal(out.inp.n, 2);
  assert.equal(out.inp.p50, 200);
  assert.equal(out['keys.toRowsMs'].n, 3);
  assert.equal(out['keys.toRowsMs'].nulls, 1);
  assert.equal(out['keys.toRowsMs'].pooled, true);
});

test('computeInp takes the worst interaction and its breakdown', () => {
  const inp = computeInp([
    { name: 'keydown', start: 0, duration: 40, interactionId: 1, inputDelay: 2, processing: 30, presentation: 8 },
    { name: 'keyup', start: 5, duration: 24, interactionId: 1, inputDelay: 1, processing: 3, presentation: 20 },
    { name: 'pointerdown', start: 50, duration: 120, interactionId: 2, inputDelay: 60, processing: 40, presentation: 20 },
    { name: 'mousemove', start: 60, duration: 200, interactionId: 0, inputDelay: 0, processing: 0, presentation: 0 },
  ]);
  assert.equal(inp.inp, 120);
  assert.equal(inp.inputDelay, 60);
  assert.equal(inp.interactions, 2);
  assert.deepEqual(inp.all, [40, 120]);
  assert.equal(computeInp([]).inp, 0);
});

test('longTaskStats and frameStats', () => {
  const lt = longTaskStats([{ start: 10, duration: 80 }, { start: 500, duration: 51 }, { start: 900, duration: 200 }], 0, 600);
  assert.deepEqual(lt, { count: 2, totalMs: 131, maxMs: 80, blockingMs: 31 });
  const fr = frameStats([16, 17, 40, 60, 16]);
  assert.equal(fr.frames, 5);
  assert.equal(fr.over33, 2);
  assert.equal(fr.over50, 1);
  assert.equal(fr.maxGapMs, 60);
});

test('summarizeNetwork separates cache hits, API calls and duplicates', () => {
  const recs = [
    { url: 'https://pokoin.com/market/assets/a.js', type: 'Script', finished: true, encodedBytes: 1000 },
    { url: 'https://pokoin.com/market/assets/a.js', type: 'Script', finished: true, encodedBytes: 900, fromMemoryCache: true },
    { url: 'https://api.pokoin.com/api/marketplace-suggest?q=p', type: 'Fetch', finished: true, encodedBytes: 300 },
    { url: 'https://api.pokoin.com/api/marketplace-suggest?q=pi', type: 'Fetch', finished: true, encodedBytes: 310 },
    { url: 'https://cdn.pokoin.com/x.webp', type: 'Image', finished: true, encodedBytes: 5000 },
    { url: 'https://cdn.pokoin.com/x.webp', type: 'Image', finished: true, encodedBytes: 5000 },
    { url: 'https://cdn.pokoin.com/y.webp', type: 'Image', failed: true },
    { url: 'data:image/png;base64,AAAA', type: 'Image', finished: true, encodedBytes: 0 },
    { url: 'https://pokoin.com/card-images/z.webp', type: 'Image', finished: true, redirect: true, redirectTo: 'https://cdn.pokoin.com/z.webp', status: 301, encodedBytes: 200 },
    { url: 'https://cdn.pokoin.com/z.webp', type: 'Image', finished: true, encodedBytes: 0 },
  ];
  const net = summarizeNetwork(recs, { hosts: ['api.pokoin.com'], pathPrefix: '/api/' });
  assert.equal(net.requests, 9);
  assert.equal(net.cached, 2);
  assert.equal(net.zeroByte, 1);
  assert.equal(net.redirects, 1);
  assert.equal(net.redirectSamples[0].to, 'https://cdn.pokoin.com/z.webp');
  assert.equal(net.downloads, 5);
  assert.equal(net.failed, 1);
  assert.equal(net.bytes, 11610);
  assert.equal(net.apiCalls, 2);
  assert.deepEqual(net.apiByPath, { '/api/marketplace-suggest': 2 });
  assert.equal(net.imageDownloads, 2);
  assert.equal(net.duplicateDownloads, 1);
  assert.equal(net.bytesByType.Image, 10000);
});
