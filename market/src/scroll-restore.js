/** SPA back/forward window scroll. BrowserRouter has no <ScrollRestoration>.
 *
 * Keys are history `location.key` (one slot per stack entry). PUSH still
 * starts at the top. POP restores Y after the page is tall enough — infinite
 * grids must also stash `shown` via rememberPageView so the list can grow.
 * The storage and restore loop live in scroll-memory.js (shared with Solid).
 */
import { useLayoutEffect, useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { peekScroll, readWindowY, rememberScroll, restoreWindowY } from './scroll-memory.js';

export {
  maxWindowScroll,
  peekPageView,
  peekScroll,
  readWindowY,
  rememberPageView,
  rememberScroll,
  resetScrollRestoreForTests,
  restoreWindowY,
  restoredPageView,
} from './scroll-memory.js';

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
