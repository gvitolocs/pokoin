import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/chunk-reload.js', import.meta.url), 'utf8');
const OWN_ENTRY = '/market/s/index-OLD.js';

/**
 * Runs public/chunk-reload.js against a fake window. `site` maps a path to the
 * status the network answers (default 404); `/market/app` answers `shell`.
 */
function boot({ site = {}, shell = `<script type="module" crossorigin src="${OWN_ENTRY}"></script>`, storage = new Map(), onLine = true, storageThrows = false } = {}) {
  const listeners = {};
  const fetches = [];
  const timers = [];
  let reloads = 0;
  const sessionStorage = {
    getItem: (key) => {
      if (storageThrows) throw new Error('SecurityError');
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem: (key, value) => {
      if (storageThrows) throw new Error('SecurityError');
      storage.set(key, String(value));
    },
  };
  const win = {
    document: {
      querySelector: () => ({ getAttribute: () => OWN_ENTRY }),
    },
    navigator: { onLine },
    sessionStorage,
    location: { reload: () => { reloads += 1; } },
    setTimeout: (fn) => { timers.push(fn); },
    fetch: async (url, init) => {
      fetches.push({ url, cache: init?.cache });
      if (url === '/market/app') return new Response(shell, { status: 200 });
      return new Response('', { status: site[url] || 404 });
    },
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
  };
  win.window = win;
  const context = createContext({ window: win, String, Number, Boolean, Date, Promise, Response });
  runInContext(source, context);
  const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
  return {
    win,
    fire,
    fetches,
    storage,
    timers,
    get reloads() { return reloads; },
    context,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const importError = (file) => new Error(`Failed to fetch dynamically imported module: https://pokoin.com/market/s/${file}`);

test('a failed lazy route refetches the chunk past the cache, then reloads once', async () => {
  const page = boot({ site: { '/market/s/Card-NEW.js': 200 } });
  page.fire('vite:preloadError', { payload: importError('Card-NEW.js') });
  await settle();
  assert.deepEqual(page.fetches[0], { url: '/market/s/Card-NEW.js', cache: 'reload' });
  assert.equal(page.reloads, 1);
  assert.ok(Number(page.storage.get('pokoin:chunk-reload-at')) > 0);

  // The same failure right after the reload: no second reload (loop guard).
  const again = boot({ site: { '/market/s/Card-NEW.js': 200 }, storage: page.storage });
  again.fire('vite:preloadError', { payload: importError('Card-NEW.js') });
  await settle();
  assert.equal(again.reloads, 0);
  assert.equal(again.fetches.length, 0);
  assert.equal(again.win.__pokoinChunkReload(importError('Card-NEW.js')), false);
});

test('the guard expires, so a later release can recover the same tab', async () => {
  const storage = new Map([['pokoin:chunk-reload-at', String(Date.now() - 61_000)]]);
  const page = boot({ site: { '/market/s/Card-NEW.js': 200 }, storage });
  page.fire('vite:preloadError', { payload: importError('Card-NEW.js') });
  await settle();
  assert.equal(page.reloads, 1);
});

test('a chunk gone for good reloads at once when a newer shell is live', async () => {
  const page = boot({ shell: '<script type="module" crossorigin src="/market/s/index-NEW.js"></script>' });
  page.fire('unhandledrejection', { reason: new TypeError('Importing a module script failed.') });
  await settle();
  assert.deepEqual(page.fetches.map((row) => row.url), ['/market/app']);
  assert.equal(page.fetches[0].cache, 'no-store');
  assert.equal(page.reloads, 1);
});

test('same shell and chunk still 404: retry while the deploy propagates, then reload', async () => {
  const site = {};
  const page = boot({ site });
  page.fire('error', { target: { tagName: 'SCRIPT', src: 'https://pokoin.com/market/s/index-OLD.js' } });
  await settle();
  assert.equal(page.reloads, 0);
  assert.equal(page.timers.length, 1);
  site['/market/s/index-OLD.js'] = 200;
  page.timers.shift()();
  await settle();
  assert.equal(page.reloads, 1);

  // Never reachable: give up after the last try and reload anyway (guarded).
  const stuck = boot();
  stuck.fire('error', { target: { tagName: 'LINK', rel: 'stylesheet', href: '/market/s/index-OLD.css' } });
  for (let i = 0; i < 10 && stuck.reloads === 0; i += 1) {
    await settle();
    if (stuck.timers.length) stuck.timers.shift()();
  }
  await settle();
  assert.equal(stuck.reloads, 1);
});

test('ignores prefetch hints, unrelated errors, offline pages, and pages without storage', async () => {
  const page = boot({ site: { '/market/s/x.js': 200 } });
  page.fire('error', { target: { tagName: 'LINK', rel: 'prefetch', href: '/market/s/x.js' } });
  page.fire('error', { target: { tagName: 'IMG', src: '/market/s/x.png' } });
  page.fire('error', { target: page.win, message: 'Script error.' });
  page.fire('unhandledrejection', { reason: new Error('HTTP 500 /api/marketplace-card-page') });
  page.fire('error', { target: { tagName: 'SCRIPT', src: '/market/card-url-boot.js' } });
  await settle();
  assert.equal(page.fetches.length, 0);
  assert.equal(page.win.__pokoinChunkReload(new Error('boom')), false);

  const offline = boot({ onLine: false, site: { '/market/s/x.js': 200 } });
  offline.fire('vite:preloadError', { payload: importError('x.js') });
  await settle();
  assert.equal(offline.reloads, 0);

  const locked = boot({ storageThrows: true, site: { '/market/s/x.js': 200 } });
  locked.fire('vite:preloadError', { payload: importError('x.js') });
  await settle();
  assert.equal(locked.reloads, 0);
});

test('the route error boundary hook starts one recovery for chunk errors only', async () => {
  const page = boot({ site: { '/market/s/Card-NEW.js': 200 } });
  assert.equal(page.win.__pokoinChunkReload(importError('Card-NEW.js')), true);
  assert.equal(page.win.__pokoinChunkReload(importError('Card-NEW.js')), true);
  await settle();
  assert.equal(page.fetches.filter((row) => row.url === '/market/s/Card-NEW.js').length, 1);
  assert.equal(page.reloads, 1);
  assert.equal(page.context.isChunkLoadError(new Error('Failed to fetch')), false);
  assert.equal(page.context.chunkPath('https://pokoin.com/market/s/a-B.js?x=1'), '/market/s/a-B.js');
});
