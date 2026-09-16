/** SPA back/forward window scroll. BrowserRouter has no <ScrollRestoration>.
 *
 * Keys are history `location.key` (one slot per stack entry). PUSH still
 * starts at the top. POP restores Y after the page is tall enough — infinite
 * grids must also stash `shown` via rememberPageView so the list can grow.
 */
import { useLayoutEffect, useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

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

export function useWindowScrollRestore() {
  const location = useLocation();
  const navType = useNavigationType();
  const stackKey = location.key;
  const href = `${location.pathname}${location.search}`;
  const yRef = useRef(0);

  useLayoutEffect(() => {
    try {
      window.history.scrollRestoration = 'manual';
    } catch {
      /* jsdom */
    }
  }, []);

  useLayoutEffect(() => {
    return () => {
      rememberScroll(stackKey, { y: yRef.current, path: href });
    };
  }, [stackKey, href]);

  useEffect(() => {
    function persist() {
      const y = readWindowY();
      yRef.current = y;
      rememberScroll(stackKey, { y, path: href });
    }
    let frame = 0;
    function onScrollRaf() {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        persist();
      });
    }
    window.addEventListener('scroll', onScrollRaf, { passive: true });
    window.addEventListener('pagehide', persist);
    window.addEventListener('pointerdown', persist, true);
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        persist();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('scroll', onScrollRaf);
      window.removeEventListener('pagehide', persist);
      window.removeEventListener('pointerdown', persist, true);
      document.removeEventListener('visibilitychange', onVisibility);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [stackKey, href]);

  useLayoutEffect(() => {
    if (location.hash) {
      return undefined;
    }
    if (navType === 'POP') {
      const saved = peekScroll(stackKey);
      if (saved && saved.y > 0 && (!saved.path || saved.path === href)) {
        yRef.current = saved.y;
        return restoreWindowY(saved.y, { path: href });
      }
      return undefined;
    }
    yRef.current = 0;
    window.scrollTo(0, 0);
    return undefined;
  }, [stackKey, href, location.hash, navType]);
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
