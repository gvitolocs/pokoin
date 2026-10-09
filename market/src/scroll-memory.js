/** Per-history-entry window scroll + page view memory, framework-free.
 *
 * Keys are history entry ids (React Router `location.key`, the Solid router's
 * history depth). PUSH starts at the top; POP restores Y after the page is
 * tall enough — infinite grids also stash `shown` via rememberPageView so the
 * list can grow back. React binds it in scroll-restore.js; Solid in
 * solid/src/lib/scroll-restore.js.
 */

const STORAGE_KEY = 'pokoin.scrollRestore.v1';
const MAX_ENTRIES = 48;
const RESTORE_MS = 2500;

function emptyState() {
  return { order: [], entries: {} };
}

let memoryState = emptyState();

function storage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function loadState() {
  const store = storage();
  if (!store?.getItem) {
    return memoryState;
  }
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || 'null');
    if (parsed?.entries && Array.isArray(parsed.order)) {
      memoryState = parsed;
      return parsed;
    }
  } catch {
    /* quota / private mode / bad JSON */
  }
  return memoryState;
}

function saveState(state) {
  memoryState = state;
  const store = storage();
  if (!store?.setItem) {
    return;
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota */
  }
}

function historyKey(key) {
  return String(key || '') || 'default';
}

export function readWindowY() {
  const win = globalThis.window;
  if (!win) {
    return 0;
  }
  const doc = win.document?.documentElement;
  return Math.max(0, Math.round(win.scrollY || doc?.scrollTop || 0));
}

export function maxWindowScroll() {
  const win = globalThis.window;
  if (!win) {
    return 0;
  }
  const doc = win.document?.documentElement;
  const height = doc?.scrollHeight || 0;
  return Math.max(0, height - win.innerHeight);
}

export function peekScroll(key) {
  const id = historyKey(key);
  const state = loadState();
  return state.entries[id] || null;
}

export function peekPageView(key) {
  return peekScroll(key)?.view || null;
}

export function rememberScroll(key, patch = {}) {
  const id = historyKey(key);
  if (!id) {
    return null;
  }
  const state = loadState();
  const prev = state.entries[id] || {};
  const next = {
    ...prev,
    ...patch,
    view: patch.view ? { ...(prev.view || {}), ...patch.view } : prev.view,
  };
  if (typeof next.y === 'number' && !Number.isFinite(next.y)) {
    next.y = 0;
  }
  state.entries[id] = next;
  state.order = [...state.order.filter((item) => item !== id), id];
  while (state.order.length > MAX_ENTRIES) {
    const drop = state.order.shift();
    delete state.entries[drop];
  }
  saveState(state);
  return next;
}

export function rememberPageView(key, view) {
  const win = globalThis.window;
  const path = win ? `${win.location.pathname}${win.location.search}` : '';
  return rememberScroll(key, { view, ...(path ? { path } : {}) });
}

export function restoredPageView(navType, key, path = '') {
  if (navType !== 'POP') {
    return null;
  }
  const saved = peekScroll(key);
  if (!saved?.view) {
    return null;
  }
  if (path && saved.path && saved.path !== path) {
    return null;
  }
  return saved.view;
}

export function restoreWindowY(y, { path } = {}) {
  const target = Math.max(0, Math.round(Number(y) || 0));
  const win = globalThis.window;
  if (!win || target <= 0) {
    return () => {};
  }
  let cancelled = false;
  let tries = 0;
  const tick = () => {
    if (cancelled) {
      return;
    }
    if (path) {
      const now = `${win.location.pathname}${win.location.search}`;
      if (now && path !== now) {
        return;
      }
    }
    const top = Math.min(target, maxWindowScroll());
    win.scrollTo(0, top);
    tries += 1;
    if (top >= target - 1 || tries >= 90) {
      return;
    }
    win.requestAnimationFrame(tick);
  };
  tick();
  const doc = win.document?.documentElement;
  const ro = win.ResizeObserver && doc
    ? new win.ResizeObserver(() => tick())
    : null;
  ro?.observe(doc);
  const timer = win.setTimeout(() => {
    cancelled = true;
    ro?.disconnect();
  }, RESTORE_MS);
  return () => {
    cancelled = true;
    ro?.disconnect();
    win.clearTimeout(timer);
  };
}

export function resetScrollRestoreForTests() {
  memoryState = emptyState();
  const store = storage();
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    /* tests */
  }
}
