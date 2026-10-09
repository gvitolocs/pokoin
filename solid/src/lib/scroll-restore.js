/**
 * Back/forward memory for the Solid UI (React: market/src/scroll-restore.js,
 * Codevira D00005C). Browser back restores the window scroll and the page view
 * (filters, shown count) of that history entry; a push starts at the top.
 *
 * The storage and the restore loop are shared with React (scroll-memory.js,
 * same sessionStorage slots). What differs is the router:
 *
 * - Solid router 2 has no `location.key`; the entry id is the `_depth` it
 *   stamps on every history entry (`solid:<depth>`). A depth is reused after
 *   back + push, so every read also checks the saved path.
 * - It has no navigation type. A popstate marks its entry as a POP arrival; a
 *   reload / back_forward document load marks the first entry the same way.
 * - It writes history only once a navigation settles: while a pushed page
 *   renders, `window.location` still shows the previous entry. Writes for a
 *   page wait until the URL is the page's own (`whenCommitted`).
 * - The router restores Y itself, once, when the traversal settles. A page
 *   whose content arrives later (search results) chases the saved Y with
 *   `restoreScroll` as it grows, like React's restoreWindowY.
 *
 * Imported eagerly (router.js) so the first popstate is already observed.
 */
import {
  peekScroll,
  readWindowY,
  rememberPageView,
  rememberScroll,
  restoredPageView,
  restoreWindowY,
} from '@market/scroll-memory.js';

const browser = typeof window !== 'undefined';
/** Back/forward data snapshots: same lifetime as the router's own back cache. */
const DATA_MAX_AGE_MS = 5 * 60 * 1000;
const DATA_MAX = 8;
const COMMIT_FRAMES = 120;

function depth() {
  const value = browser ? window.history.state?._depth : null;
  return value == null ? null : value;
}

function windowHref() {
  return browser ? `${window.location.pathname}${window.location.search}` : '';
}

function keyOf(value) {
  return value == null ? null : `solid:${value}`;
}

/** The committed history entry's id, or null before the router stamped it. */
export function entryKey() {
  return keyOf(depth());
}

let pop = null;
/** Y of the entry on screen, kept in memory and flushed when it is left. */
let live = null;

function flushLive() {
  if (live?.key) rememberScroll(live.key, { y: live.y, path: live.path });
}

function track() {
  const key = entryKey();
  if (!key) return;
  const path = windowHref();
  if (live && (live.key !== key || live.path !== path)) flushLive();
  live = { key, path, y: readWindowY() };
}

if (browser) {
  const [nav] = performance.getEntriesByType?.('navigation') || [];
  if (nav && nav.type !== 'navigate') pop = { depth: depth(), href: windowHref() };
  window.addEventListener('popstate', () => {
    // The entry being left: its last Y, before anything reads the new one.
    flushLive();
    live = null;
    pop = { depth: depth(), href: windowHref() };
  });
  window.addEventListener('scroll', track, { passive: true });
  // Taps and clicks that navigate away read the freshest offset (React: pointerdown persist).
  window.addEventListener('pointerdown', () => {
    track();
    flushLive();
  }, true);
  window.addEventListener('pagehide', () => {
    track();
    flushLive();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      track();
      flushLive();
    }
  });
}

/** True when `href` is on screen because of back/forward (or a reload of it). */
export function isPopArrival(href) {
  const now = windowHref();
  return Boolean(pop && now === href && pop.href === now && pop.depth === depth());
}

/**
 * Run `fn(key)` once `href` is the committed URL (a pushed page renders
 * before the router writes history). Gives up if the URL settles elsewhere.
 */
export function whenCommitted(href, fn) {
  if (!browser) return;
  let frames = 0;
  const attempt = () => {
    const key = entryKey();
    if (key && windowHref() === href) {
      fn(key);
      return;
    }
    frames += 1;
    if (frames < COMMIT_FRAMES) window.requestAnimationFrame(attempt);
  };
  attempt();
}

/** The view saved for this entry when it is a back/forward arrival at `href`. */
export function restoredView(href) {
  return isPopArrival(href) ? restoredPageView('POP', entryKey(), href) : null;
}

/** Merge `view` into this page's history entry (once committed). */
export function rememberView(href, view) {
  whenCommitted(href, (key) => rememberPageView(key, view));
}

const snapshots = new Map();

/**
 * In-memory page data for an entry, so back paints it without a request.
 * Memory only (never sessionStorage); bounded; read back for 5 minutes.
 */
export function rememberEntryData(href, data) {
  whenCommitted(href, (key) => {
    snapshots.delete(key);
    snapshots.set(key, { href, at: Date.now(), data });
    while (snapshots.size > DATA_MAX) snapshots.delete(snapshots.keys().next().value);
  });
}

export function peekEntryData(href, maxAgeMs = DATA_MAX_AGE_MS) {
  if (!isPopArrival(href)) return null;
  const row = snapshots.get(entryKey());
  if (!row || row.href !== href || Date.now() - row.at > maxAgeMs) return null;
  return row.data;
}

/**
 * Back/forward arrival at `href`: scroll to the saved Y as the page grows
 * (2.5 s budget, shared loop). Wheel, touch or keys hand control back to the
 * user. Returns a stop function.
 */
export function restoreScroll(href) {
  if (!isPopArrival(href)) return () => {};
  const saved = peekScroll(entryKey());
  if (!saved || !(saved.y > 0) || (saved.path && saved.path !== href)) return () => {};
  const stopLoop = restoreWindowY(saved.y, { path: href });
  const events = ['wheel', 'touchstart', 'keydown'];
  const stop = () => {
    stopLoop();
    for (const type of events) window.removeEventListener(type, stop, true);
  };
  for (const type of events) window.addEventListener(type, stop, { capture: true, passive: true });
  return stop;
}
