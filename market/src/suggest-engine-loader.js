/**
 * Lazy loader for the suggest engine chunk. Memoised so the header imports the
 * engine once, on search intent, and every consumer of useSuggestEngine() sees
 * the same module. A failed import resets the memo so a later call retries.
 */

let engine = null;
let loading = null;
const subscribers = new Set();

export function peekSuggestEngine() {
  return engine;
}

export function subscribeSuggestEngine(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function loadSuggestEngine() {
  if (loading) {
    return loading;
  }
  loading = import('./suggest-engine.js')
    .then((mod) => {
      engine = mod;
      for (const fn of subscribers) {
        fn();
      }
      return engine;
    })
    .catch((error) => {
      loading = null;
      throw error;
    });
  return loading;
}

/** Defer the chunk until after first paint; never blocks the initial render. */
export function loadSuggestEngineAfterPaint() {
  if (loading) {
    return;
  }
  const run = () => loadSuggestEngine().catch(() => {});
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(run, 0));
  } else {
    setTimeout(run, 0);
  }
}
