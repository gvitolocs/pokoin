import { createSignal } from 'solid-js';

/**
 * Bridge a `subscribe(fn) → unsubscribe` + `getSnapshot()` store (the shape
 * React reads with useSyncExternalStore) into one app-lifetime Solid accessor.
 * Call at module scope: it is a global, not per component. The updater form
 * keeps function-valued snapshots from being read as updaters.
 */
export function fromExternalStore(subscribe, getSnapshot) {
  const [value, setValue] = createSignal(getSnapshot());
  subscribe(() => {
    const next = getSnapshot();
    setValue(() => next);
  });
  return value;
}
