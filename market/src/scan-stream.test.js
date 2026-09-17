import assert from 'node:assert/strict';
import test from 'node:test';
import { backoffMs, connectScanStream, createSseParser } from './scan-stream.js';

test('SSE parser handles split chunks, comments, and bad JSON', () => {
  const seen = [];
  const feed = createSseParser((name, data) => seen.push([name, data]));
  feed('retry: 1000\nevent: hel');
  feed('lo\ndata: {"a":1}\n\n: ping\n\nevent: items\ndata: {"cursor":');
  feed('3}\n\nevent: items\ndata: {broken\n\n');
  assert.deepEqual(seen, [['hello', { a: 1 }], ['items', { cursor: 3 }]]);
});

test('backoff grows to 8 s with jitter', () => {
  assert.equal(backoffMs(0, () => 0.5), 400);
  assert.equal(backoffMs(3, () => 0.5), 3200);
  assert.equal(backoffMs(10, () => 0.5), 8000);
  assert.equal(backoffMs(0, () => 0), 300);
});

function streamResponse(frames, status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader: () => ({
        read: async () => (i < frames.length ? { value: encoder.encode(frames[i++]), done: false } : { value: undefined, done: true }),
      }),
    },
  };
}

test('reconnects after the server closes, resuming from the cursor; refreshes the token on 401; stops on 404', async () => {
  const urls = [];
  const tokens = [];
  const events = [];
  const statuses = [];
  const responses = [
    streamResponse(['event: hello\ndata: {}\n\n', 'event: items\ndata: {"items":[{"id":"a","seq":4}],"cursor":4}\n\n', 'event: bye\ndata: {}\n\n']),
    streamResponse([], 401),
    streamResponse(['event: items\ndata: {"items":[{"id":"b","seq":9}],"cursor":9}\n\n']),
    streamResponse([], 404),
  ];
  let done;
  const finished = new Promise((resolve) => {
    done = resolve;
  });
  const handle = connectScanStream({
    batchId: 'B',
    urlFor: (batchId, cursor) => `/s?b=${batchId}&after=${cursor}`,
    getToken: async (force) => {
      tokens.push(force);
      return force ? 'fresh' : 'old';
    },
    onEvent: (name, data) => events.push(name),
    onStatus: (s) => {
      statuses.push(s);
      if (s === 'gone') done();
    },
    fetchImpl: async (url, init) => {
      urls.push([url, init.headers.Authorization]);
      return responses.shift();
    },
    sleep: async () => {},
  });
  await finished;
  assert.deepEqual(urls, [
    ['/s?b=B&after=0', 'Bearer old'],
    ['/s?b=B&after=4', 'Bearer old'],
    ['/s?b=B&after=4', 'Bearer fresh'],
    ['/s?b=B&after=9', 'Bearer old'],
  ]);
  assert.deepEqual(events, ['hello', 'items', 'bye', 'items']);
  assert.equal(handle.cursor, 9);
  assert.ok(statuses.includes('live'));
  assert.ok(statuses.includes('reconnecting'));
  assert.equal(statuses.at(-1), 'gone');
});

test('network failure backs off and recovers; stop() ends the loop', async () => {
  let calls = 0;
  const sleeps = [];
  let handle;
  await new Promise((resolve) => {
    handle = connectScanStream({
      batchId: 'B',
      urlFor: (b, c) => `/s?after=${c}`,
      getToken: async () => 't',
      onEvent: () => {},
      onStatus: (s) => {
        if (s === 'live') {
          handle?.stop();
          resolve();
        }
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('Failed to fetch');
        return streamResponse(['event: hello\ndata: {}\n\n']);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] >= sleeps[0] * 1.2);
});
