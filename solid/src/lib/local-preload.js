import { getOwner, runWithOwner } from 'solid-js';

/**
 * Entry stubs for lib/local-prefetch.js, which is its own chunk (the queue,
 * the viewport scan and the desk follow-up are not needed to paint). The
 * chunk loads right after boot; hovers before it lands only miss a prefetch.
 */
let module = null;
const prefetch = () => (module ||= import('./local-prefetch.js'));

/** Router `preloadLinks` strategy: installs local-prefetch's `localPreload` under the router's owner. */
export function localPreload(options) {
  return (ctx) => {
    const owner = getOwner();
    prefetch().then((m) => runWithOwner(owner, () => m.localPreload(options)(ctx))).catch(() => {});
  };
}

/** local-prefetch's `prefetchAfterDesk`, once its chunk is in. */
export function prefetchAfterDesk(page, options) {
  prefetch().then((m) => m.prefetchAfterDesk(page, options)).catch(() => {});
}
