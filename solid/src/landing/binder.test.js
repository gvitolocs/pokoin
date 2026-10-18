import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { AUTH_SESSION_KEY, AUTH_TOKEN_COOKIE, LANDING_BINDER_KEY } from '../../../market/src/auth-session.js';
import { readBinderCache, writeBinderCache } from '../../../market/src/landing-binder.js';

/* A minimal DOM: enough for binder.js to paint and restore the hero binder. */
class FakeClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  contains(name) { return this.set.has(name); }
  add(name) { const s = this.set; s.add(name); this.el.className = [...s].join(' '); }
  remove(name) { const s = this.set; s.delete(name); this.el.className = [...s].join(' '); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.children = [];
    this.attributes = {};
    this.style = { width: '', removeProperty: (key) => { this.style[key] = ''; } };
    this.textContent = '';
    this.classList = new FakeClassList(this);
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'title') this.title = undefined; }
  addEventListener() {}
  cloneNode() {
    const copy = new FakeElement(this.tagName);
    Object.assign(copy, { className: this.className, src: this.src, href: this.href, textContent: this.textContent });
    copy.classList = new FakeClassList(copy);
    copy.children = this.children.map((child) => child.cloneNode(true));
    return copy;
  }
}

function demoBinder() {
  const make = (tag, props = {}) => Object.assign(new FakeElement(tag), props);
  const grid = make('div', { className: 'binder-grid' });
  for (let i = 0; i < 9; i += 1) {
    const slot = make('span', { className: i === 0 ? 'binder-slot is-scanning' : 'binder-slot' });
    slot.append(make('img', { src: `https://cdn.pokoin.com/demo-${i}_homepage.webp` }));
    grid.append(slot);
  }
  const parts = {
    '.binder-head strong': make('strong', { textContent: 'My collection' }),
    '.binder-head div > span': make('span', { textContent: 'Favourite pulls' }),
    '.binder-count': make('span', { textContent: '9 / 18' }),
    '.binder-progress span': make('span'),
    '.binder-grid': grid,
  };
  const binder = make('div', { className: 'binder' });
  binder.querySelector = (selector) => parts[selector] || null;
  return { binder, parts };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

const root = new FakeElement('html');
globalThis.localStorage = memoryStorage();
globalThis.document = {
  cookie: '',
  documentElement: root,
  createElement: (tag) => new FakeElement(tag),
};
globalThis.Image = class {
  set src(url) {
    this._src = url;
    queueMicrotask(() => (url.includes('broken') ? this.onerror?.() : this.onload?.()));
  }
  get src() { return this._src; }
};

// binder.js imports through the Vite alias; resolve `@market/` the same way here.
const marketDir = new URL('../../../market/src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  return next(specifier.startsWith('@market/') ? ${JSON.stringify(marketDir)} + specifier.slice(8) : specifier, context);
}`)}`);

const { mountBinder } = await import('./binder.js');
const { syncBinder, binderHref, binderImage } = await import('./binder-sync.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const now = () => (fn) => fn();

function signIn(uid) {
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ uid, signedIn: true }));
}

function reset() {
  localStorage.clear();
  document.cookie = '';
  root.className = '';
}

function page(uid, n, total = n) {
  return {
    uid,
    total,
    cards: Array.from({ length: n }, (_, i) => ({
      id: String(500 + i),
      name: `${uid} card ${i}`,
      src: `https://cdn.pokoin.com/${500 + i}_${uid}_homepage.webp`,
      full: '',
      href: `/marketplace/en/cards/${500 + i}`,
    })),
  };
}

const slotSources = (grid) => grid.children.map((slot) => slot.children[0]?.src || null);

test('signed out: the demo cards stay, no read runs, and a stored page is dropped', async () => {
  reset();
  writeBinderCache(page('alice', 9));
  root.classList.add('binder-mine');
  const { binder, parts } = demoBinder();
  let reads = 0;
  mountBinder(binder, { whenIdle: now(), sync: async () => { reads += 1; return { kind: 'error' }; } });
  await settle();
  assert.equal(reads, 0);
  assert.equal(parts['.binder-count'].textContent, '9 / 18');
  assert.match(slotSources(parts['.binder-grid'])[0], /demo-0/);
  assert.equal(localStorage.getItem(LANDING_BINDER_KEY), null);
  assert.ok(!root.classList.contains('binder-mine'));
});

test('signed in with a stored page: it paints at once, links each slot, and a same answer does not repaint', async () => {
  reset();
  signIn('alice');
  writeBinderCache(page('alice', 9, 42));
  root.classList.add('binder-mine');
  const { binder, parts } = demoBinder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mountBinder(binder, { whenIdle: now(), sync: () => gate });
  await settle();
  // Painted from storage before the network answered.
  const grid = parts['.binder-grid'];
  assert.equal(grid.children.length, 9);
  assert.equal(grid.children[0].tagName, 'A');
  assert.equal(grid.children[0].href, '/marketplace/en/cards/500');
  assert.equal(grid.children[0].attributes['aria-label'], 'alice card 0');
  assert.ok(grid.children[0].className.includes('is-scanning'));
  assert.equal(grid.children[0].children[1].className, 'scan-line');
  assert.equal(parts['.binder-count'].textContent, '9 / 42');
  assert.equal(parts['.binder-progress span'].style.width, '21%');
  assert.ok(binder.classList.contains('is-own'));
  assert.ok(!root.classList.contains('binder-mine'));

  const painted = grid.children;
  release({ kind: 'page', page: page('alice', 9, 42) });
  await settle();
  assert.equal(grid.children, painted, 'an unchanged page keeps the same slots');
});

test("another account's stored page is never shown; that visitor's own page is", async () => {
  reset();
  signIn('bob');
  writeBinderCache(page('alice', 9));
  const { binder, parts } = demoBinder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mountBinder(binder, { whenIdle: now(), sync: () => gate });
  await settle();
  assert.match(slotSources(parts['.binder-grid'])[0], /demo-0/, 'Alice\'s cards never paint for Bob');
  release({ kind: 'page', page: page('bob', 3) });
  await settle();
  const sources = slotSources(parts['.binder-grid']);
  assert.match(sources[0], /_bob_/);
  assert.equal(sources.filter(Boolean).length, 3);
  // The rest of the nine slots stay as empty pockets.
  assert.equal(parts['.binder-grid'].children.length, 9);
  assert.ok(parts['.binder-grid'].children[8].className.includes('is-empty'));
  assert.equal(parts['.binder-count'].textContent, '3 / 3');
});

test('an empty collection puts the demo back', async () => {
  reset();
  signIn('alice');
  writeBinderCache(page('alice', 9));
  const { binder, parts } = demoBinder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mountBinder(binder, { whenIdle: now(), sync: () => gate });
  await settle();
  assert.equal(parts['.binder-count'].textContent, '9 / 9');
  release({ kind: 'empty' });
  await settle();
  assert.equal(parts['.binder-count'].textContent, '9 / 18');
  assert.equal(parts['.binder-head div > span'].textContent, 'Favourite pulls');
  assert.match(slotSources(parts['.binder-grid'])[0], /demo-0/);
  assert.ok(!binder.classList.contains('is-own'));
});

test('a failed read keeps the painted page', async () => {
  reset();
  signIn('alice');
  writeBinderCache(page('alice', 5));
  const { binder, parts } = demoBinder();
  mountBinder(binder, { whenIdle: now(), sync: async () => ({ kind: 'error' }) });
  await settle();
  assert.equal(parts['.binder-count'].textContent, '5 / 5');
});

function setToken(uid, token = 'mirrored-token-0123456789abcdef') {
  document.cookie = `${AUTH_TOKEN_COOKIE}=${encodeURIComponent(JSON.stringify({ token, uid, expiresAt: Date.now() + 30 * 60 * 1000 }))}`;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const holdings = (n) => Array.from({ length: n }, (_, i) => ({
  cardId: String(261321 + i),
  cardName: `Holding ${i}`,
  cardImageUrl: `https://cdn.pokoin.com/${261321 + i}_holding-${i}.jpg`,
}));

test('sync reads the first nine with the mirrored token and stores them for the answering uid', async () => {
  reset();
  setToken('alice');
  const calls = [];
  const result = await syncBinder('alice', {
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return jsonResponse(200, { uid: 'alice', items: holdings(9), itemCount: 57 });
    },
    mintToken: async () => assert.fail('Firebase is not needed with a fresh mirrored token'),
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/marketplace-collection\?limit=9$/);
  assert.equal(calls[0].auth, 'Bearer mirrored-token-0123456789abcdef');
  assert.equal(result.kind, 'page');
  assert.equal(result.page.total, 57);
  assert.equal(result.page.cards[0].href, '/marketplace/en/cards/261321');
  assert.equal(readBinderCache('alice').cards.length, 9);
});

test('sync asks Firebase when the mirrored token is missing or refused', async () => {
  reset();
  setToken('alice', 'stale-token-0123456789abcdef');
  const auths = [];
  const result = await syncBinder('alice', {
    fetchImpl: async (_url, init) => {
      auths.push(init.headers.Authorization);
      return auths.length === 1 ? jsonResponse(401, {}) : jsonResponse(200, { uid: 'alice', items: holdings(2), itemCount: 2 });
    },
    mintToken: async () => 'firebase-token-0123456789abcdef',
  });
  assert.deepEqual(auths, ['Bearer stale-token-0123456789abcdef', 'Bearer firebase-token-0123456789abcdef']);
  assert.equal(result.kind, 'page');
});

test('sync: nobody signed in on this origin, or an empty collection, clears the stored page', async () => {
  reset();
  writeBinderCache(page('alice', 9));
  let result = await syncBinder('alice', { fetchImpl: async () => assert.fail('no read without a token'), mintToken: async () => '' });
  assert.equal(result.kind, 'signed-out');
  assert.equal(localStorage.getItem(LANDING_BINDER_KEY), null);

  writeBinderCache(page('alice', 9));
  setToken('alice');
  result = await syncBinder('alice', { fetchImpl: async () => jsonResponse(200, { uid: 'alice', items: [], itemCount: 0 }) });
  assert.equal(result.kind, 'empty');
  assert.equal(localStorage.getItem(LANDING_BINDER_KEY), null);

  // A server error keeps it.
  writeBinderCache(page('alice', 9));
  result = await syncBinder('alice', { fetchImpl: async () => jsonResponse(503, {}) });
  assert.equal(result.kind, 'error');
  assert.ok(readBinderCache('alice'));
});

test('a mirrored token for another uid is not used', async () => {
  reset();
  setToken('bob');
  let minted = 0;
  await syncBinder('alice', {
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer firebase-token-0123456789abcdef');
      return jsonResponse(200, { uid: 'alice', items: holdings(1), itemCount: 1 });
    },
    mintToken: async () => { minted += 1; return 'firebase-token-0123456789abcdef'; },
  });
  assert.equal(minted, 1);
});

test('binder pictures are the CDN homepage derivative with the scan as fallback; links are desks', () => {
  const picture = binderImage({ cardId: '261321', cardName: 'Pikachu', cardImageUrl: 'https://cdn.pokoin.com/261321_pikachu.jpg' });
  assert.match(picture.src, /^https:\/\/cdn\.pokoin\.com\/.+_homepage\.webp/);
  assert.match(picture.full, /^https:\/\/cdn\.pokoin\.com\//);
  assert.equal(binderHref({ cardId: '261321' }), '/marketplace/en/cards/261321');
  assert.equal(binderHref({ cardId: 'abc' }), '');
});

test('the island mounts the binder; boot marks a stored page only for the same uid', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const island = read('./island.jsx');
  assert.match(island, /import \{ mountBinder \} from '\.\/binder\.js';/);
  assert.match(island, /querySelector\('\[data-landing-binder\]'\)/);
  // Firebase and the API read stay out of the island entry.
  const binder = read('./binder.js');
  assert.doesNotMatch(binder, /firebase|marketplace-collection/);
  assert.match(binder, /import\('\.\/binder-sync\.js'\)/);
  const boot = read('../../../home/landing-boot.js');
  assert.ok(boot.includes(`localStorage.getItem("${LANDING_BINDER_KEY}")`));
  assert.match(boot, /page\.uid === String\(s\.uid\)\.trim\(\)/);
  const html = read('../../../index.html');
  assert.match(html, /<div class="binder" data-landing-binder>/);
});
