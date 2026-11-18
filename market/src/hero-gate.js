/**
 * The card desk's hero scan goes first.
 *
 * On a phone link (1.6 Mbps, 150 ms RTT) the desk used to fetch ~900 KB
 * beside its ~140 KB hero: related and version thumbnails, the next card's
 * full scan, Google's review badge, the Firebase SDK. The hero then took
 * ~6 s instead of under one. While a desk hero loads the gate is closed;
 * work that would share the connection with it waits in `afterHero`. The
 * gate opens when the hero loads or fails, or after HERO_WAIT_MS at most,
 * and pages without a desk hero never close it.
 */
export const HERO_WAIT_MS = 6000;

/** A card desk URL (optionally under a game prefix); not its versions page. */
const DESK_PATH = /^\/(?:[a-z0-9-]+\/)?marketplace\/(?:zht|[a-z]{2}(?:-[a-z]{2})?)\/cards\/\d+(?:\/(?!versions\/?$)[^/]+)?\/?$/i;

let timer = 0;
let held = false;
const waiters = new Set();
const listeners = new Set();

function notify() {
  for (const listener of [...listeners]) {
    try {
      listener(!held);
    } catch {
      /* a listener never blocks the gate */
    }
  }
}

/** True while no desk hero is loading. */
export function heroOpen() {
  return !held;
}

/** Close the gate until `releaseHero` (the hero loaded or failed) or `ms`. */
export function holdForHero(ms = HERO_WAIT_MS) {
  clearTimeout(timer);
  timer = setTimeout(releaseHero, ms);
  if (held) return;
  held = true;
  notify();
}

export function releaseHero() {
  clearTimeout(timer);
  if (!held) return;
  held = false;
  const run = [...waiters];
  waiters.clear();
  for (const fn of run) {
    try {
      fn();
    } catch {
      /* one waiter never blocks the others */
    }
  }
  notify();
}

/** Run `fn` now when the gate is open, else once it opens. Returns a cancel. */
export function afterHero(fn) {
  if (!held) {
    fn();
    return () => {};
  }
  waiters.add(fn);
  return () => waiters.delete(fn);
}

/** `listener(open)` on every change; returns an unsubscribe. */
export function onHeroGate(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The first page load of a card desk closes the gate before anything else starts. */
export function holdIfDeskPath(pathname, ms = HERO_WAIT_MS) {
  if (!DESK_PATH.test(String(pathname || ''))) return false;
  holdForHero(ms);
  return true;
}
