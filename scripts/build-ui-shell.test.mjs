import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { bootScript, buildShell, cspHash, entryTags } from './build-ui-shell.mjs';

const REACT = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<script src="/market/card-url-boot.js"></script>
    <script type="module" crossorigin src="/market/assets/index-R.js"></script>
    <link rel="modulepreload" crossorigin href="/market/assets/vendor-R.js">
    <link rel="stylesheet" crossorigin href="/market/assets/index-R.css">
  </head><body><div id="root"></div></body></html>`;
const SOLID = `<!DOCTYPE html><html><head>
<script src="/market/card-url-boot.js"></script>
    <script type="module" crossorigin src="/market/s/index-S.js"></script>
    <link rel="stylesheet" crossorigin href="/market/s/index-S.css">
    <link rel="prefetch" href="/market/s/suggest-engine-S.js" as="script" crossorigin="">
  </head><body><div id="root"></div></body></html>`;
const OWNED = ['^/marketplace/?$', '^/marketplace/[a-z]{2}/cards/\\d+(?:/[^/]+)?/?$'];

function boot(script, { path = '/marketplace', search = '', local = {}, session = {}, framed = false, random = 0.5 } = {}) {
  const written = [];
  const store = (seed) => {
    const data = { ...seed };
    return {
      data,
      getItem: (key) => (key in data ? data[key] : null),
      setItem: (key, value) => { data[key] = String(value); },
      removeItem: (key) => { delete data[key]; },
    };
  };
  const localStorage = store(local);
  const sessionStorage = store(session);
  const window = {};
  window.self = window;
  window.top = framed ? {} : window;
  const context = createContext({
    window,
    location: { pathname: path, search },
    URLSearchParams,
    localStorage,
    sessionStorage,
    Math: { ...Math, random: () => random },
    document: { write: (html) => written.push(html) },
  });
  runInContext(script, context);
  return { ui: window.__POKOIN_UI__, written: written.join(''), local: localStorage.data, session: sessionStorage.data, switched: window.__POKOIN_UI_SWITCH__ };
}

test('entryTags removes exactly the Vite entry tags and remembers where they were', () => {
  const { tags, rest, at } = entryTags(REACT);
  assert.equal(tags.length, 3);
  assert.ok(rest.includes('card-url-boot.js'));
  assert.ok(!rest.includes('index-R.js') && !rest.includes('index-R.css'));
  assert.ok(at > rest.indexOf('card-url-boot.js'));
});

test('the shell keeps card-url-boot before the switch, and the CSP hash covers the inline script', () => {
  const shell = buildShell(REACT, SOLID, { owned: OWNED });
  assert.ok(shell.html.indexOf('card-url-boot.js') < shell.html.indexOf('<script>('));
  assert.ok(!/<script type="module"/.test(shell.html.replace(/<script>\(function[\s\S]*?<\/script>/, '')));
  assert.equal(shell.hash, cspHash(shell.script));
  assert.ok(!shell.script.includes('</script>'), 'inline script must not contain </script>');
});

test('default is React; ?ui=solid on an owned route picks Solid and sticks', () => {
  const { script } = buildShell(REACT, SOLID, { owned: OWNED });
  const plain = boot(script);
  assert.equal(plain.ui, 'react');
  assert.ok(plain.written.includes('/market/assets/index-R.js') && !plain.written.includes('index-S.js'));
  assert.equal(plain.switched, 1);
  const opted = boot(script, { search: '?ui=solid' });
  assert.equal(opted.ui, 'solid');
  assert.ok(opted.written.includes('/market/s/index-S.js') && opted.written.includes('suggest-engine-S.js'));
  assert.equal(opted.local['pokoin.ui'], 'solid');
  assert.equal(boot(script, { local: { 'pokoin.ui': 'solid' }, path: '/marketplace/en/cards/123/pikachu' }).ui, 'solid');
});

test('Solid is never chosen for routes it does not own, in frames, or right after a handoff', () => {
  const { script } = buildShell(REACT, SOLID, { owned: OWNED });
  const local = { 'pokoin.ui': 'solid' };
  assert.equal(boot(script, { local, path: '/cart' }).ui, 'react');
  assert.equal(boot(script, { local, framed: true }).ui, 'react');
  const handed = boot(script, { local, session: { 'pokoin.ui.once': 'react' } });
  assert.equal(handed.ui, 'react');
  assert.equal(handed.session['pokoin.ui.once'], undefined, 'the handoff flag is one-shot');
  assert.equal(boot(script, { local, search: '?ui=react' }).ui, 'react');
});

test('canary samples once; at 0% sampled visitors go back to React, explicit opt-ins stay', () => {
  const tags = { react: '<r>', solid: '<s>' };
  const canary = bootScript({ owned: OWNED, canary: 10, tags });
  const sampled = boot(canary, { random: 0.05 });
  assert.equal(sampled.ui, 'solid');
  assert.equal(sampled.local['pokoin.ui'], 'solid-auto');
  assert.equal(boot(canary, { random: 0.5 }).local['pokoin.ui'], 'react-auto');
  const off = bootScript({ owned: OWNED, canary: 0, tags });
  assert.equal(boot(off, { local: { 'pokoin.ui': 'solid-auto' } }).ui, 'react');
  assert.equal(boot(off, { local: { 'pokoin.ui': 'solid' } }).ui, 'solid');
  assert.equal(boot(off).local['pokoin.ui'], undefined, 'no sampling at 0%');
});

test('storage failures fall back to React and still write the tags', () => {
  const { script } = buildShell(REACT, SOLID, { owned: OWNED });
  const written = [];
  const window = {};
  window.self = window;
  window.top = window;
  runInContext(script, createContext({
    window,
    location: { pathname: '/marketplace', search: '?ui=solid' },
    URLSearchParams,
    get localStorage() { throw new Error('blocked'); },
    sessionStorage: { getItem() { throw new Error('blocked'); } },
    Math,
    document: { write: (html) => written.push(html) },
  }));
  assert.equal(window.__POKOIN_UI__, 'react');
  assert.ok(written.join('').includes('index-R.js'));
});
