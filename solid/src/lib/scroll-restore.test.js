import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { resetScrollRestoreForTests } from '../../../market/src/scroll-memory.js';

// scroll-restore.js imports through the Vite alias; resolve `@market/` the same way here.
const marketDir = new URL('../../../market/src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  return next(specifier.startsWith('@market/') ? ${JSON.stringify(marketDir)} + specifier.slice(8) : specifier, context);
}`)}`);

const STORAGE_KEY = 'pokoin.scrollRestore.v1';
let cases = 0;

function memStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => { map.delete(key); },
  };
}

/** window + document + sessionStorage as the module finds them at import time. */
function fakeBrowser(pathname, depth) {
  const frames = [];
  const handlers = new Map();
  const win = {
    location: { pathname, search: '' },
    history: { state: { _depth: depth } },
    scrollY: 0,
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = handlers.get(type);
      if (list) list.splice(list.indexOf(fn), 1);
    },
    fire(type) {
      for (const fn of [...(handlers.get(type) || [])]) fn();
    },
  };
  const commit = (path, nextDepth) => {
    win.location = { pathname: path, search: '' };
    win.history.state._depth = nextDepth;
  };
  const runFrames = () => {
    for (const fn of frames.splice(0)) fn();
  };
  return { win, commit, runFrames };
}

async function inBrowser(win, run) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    sessionStorage: globalThis.sessionStorage,
  };
  globalThis.window = win;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
  globalThis.sessionStorage = memStorage();
  resetScrollRestoreForTests();
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

const entry = (key) => JSON.parse(globalThis.sessionStorage.getItem(STORAGE_KEY) || 'null')?.entries[key] || null;

/** Fresh module instance: the parked-write state must not leak between cases. */
const freshRestore = () => import(`./scroll-restore.js?case=${cases++}`);

test('a view write parked before the commit does not overwrite a newer one', async () => {
  const { win, commit, runFrames } = fakeBrowser('/marketplace/explore', 2);
  await inBrowser(win, async () => {
    const { rememberView } = await freshRestore();
    rememberView('/marketplace/portfolio', { shown: 40 });
    commit('/marketplace/portfolio', 2);
    rememberView('/marketplace/portfolio', { shown: 200 });
    runFrames();
    assert.equal(entry('solid:2').view.shown, 200);
  });
});

test('parked writes of two different pages do not replace each other', async () => {
  const { win, commit, runFrames } = fakeBrowser('/marketplace', 2);
  await inBrowser(win, async () => {
    const { rememberView } = await freshRestore();
    rememberView('/marketplace/portfolio', { shown: 80 });
    rememberView('/marketplace/explore', { shown: 120 });
    commit('/marketplace/portfolio', 2);
    runFrames();
    assert.equal(entry('solid:2').view.shown, 80);
    commit('/marketplace/explore', 3);
    runFrames();
    assert.equal(entry('solid:3').view.shown, 120);
  });
});
