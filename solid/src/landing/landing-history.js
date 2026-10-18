// Relative so node --test can load this module (it does not apply the Vite @market alias).
import { isMarketplaceHomePath } from '../../../market/src/game.js';

/**
 * Router history for the landing's search box.
 *
 * pokoin.com/ is a static page, not the marketplace app. The header SearchBox
 * mounted there runs inside a router that believes it sits on a marketplace
 * home: `/marketplace`, or `/one-piece/marketplace` once the game picker
 * chose another game. That move stays here (game() follows it, so the box
 * searches that game). Every other navigation — the search page, a card desk,
 * a seller — is a real document load into the SPA, after which the router
 * goes back to the home it left (a page restored from the back/forward cache
 * shows the box as it was).
 */
export function landingHistory({ initial = '/marketplace', assign } = {}) {
  let home = initial;
  let notify = null;
  const load = assign || ((href) => window.location.assign(href));
  return {
    get: () => home,
    set({ value }) {
      if (isMarketplaceHomePath(value)) {
        home = value;
        return;
      }
      load(value);
      // The router already moved to `value`; settle it back on the home.
      queueMicrotask(() => notify?.(home));
    },
    init(listener) {
      notify = listener;
      return () => {
        notify = null;
      };
    },
  };
}
