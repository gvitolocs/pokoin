import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createSuggestFlip } from './suggest-flip.js';
import { fitSuggestTitles } from './suggest-title-fit.js';
import { peekSuggestEngine, subscribeSuggestEngine } from './suggest-engine-loader.js';

/** React binding of createSuggestFlip (suggest-flip.js): run after every row change. */
export function useSuggestFlip(listRef, ids) {
  const flip = useRef(null);
  if (!flip.current) flip.current = createSuggestFlip();
  useLayoutEffect(() => {
    flip.current.update(listRef?.current);
    return () => flip.current.dispose();
  }, [listRef, ids]);
}

/**
 * Fits suggest titles whenever the rows change (`key`), the list width
 * changes (rotation, desktop ↔ phone breakpoint), or a web font finishes
 * loading. Declare before useSuggestFlip so FLIP measures fitted rows.
 */
export function useSuggestTitleFit(listRef, key) {
  useLayoutEffect(() => {
    const root = listRef?.current;
    if (!root || !key) return undefined;
    fitSuggestTitles(root);
    let width = root.clientWidth;
    let live = true;
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        if (root.clientWidth === width) return;
        width = root.clientWidth;
        fitSuggestTitles(root, { reset: true });
      })
      : null;
    observer?.observe(root);
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    if (fonts && fonts.status !== 'loaded') {
      fonts.ready.then(() => {
        if (live) fitSuggestTitles(root, { reset: true });
      });
    }
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [listRef, key]);
}

/** The lazily loaded suggest engine module, or null until it has loaded. */
export function useSuggestEngine() {
  return useSyncExternalStore(subscribeSuggestEngine, peekSuggestEngine, () => null);
}
