import { createSignal } from 'solid-js';

/**
 * A code-split module loaded on demand (hover, click, idle) instead of with
 * the first paint. `mod()` is null until it arrives, so callers render
 * nothing — no Loading boundary, no route-level fallback. Call at module
 * scope: one load per app lifetime; a failed load can be retried.
 */
export function lazyModule(load) {
  const [mod, setMod] = createSignal(null);
  let pending = null;
  function ensure() {
    if (!pending) {
      pending = load().then(
        (loaded) => {
          setMod(() => loaded);
          return loaded;
        },
        (err) => {
          pending = null;
          throw err;
        },
      );
    }
    return pending;
  }
  return { mod, ensure, warm: () => ensure().catch(() => {}) };
}
