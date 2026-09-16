import { useLayoutEffect, useRef } from 'react';

const MOVE_MS = 180;

/**
 * CardTrader-style list motion: rows keep their id and slide to the new slot.
 * First paint does not animate (empty previous map).
 */
export function useSuggestFlip(listRef, ids) {
  const prev = useRef(new Map());
  useLayoutEffect(() => {
    const root = listRef?.current;
    if (!root) {
      prev.current = new Map();
      return;
    }
    const nodes = root.querySelectorAll('[data-suggest-id]');
    const next = new Map();
    const hadPrev = prev.current.size > 0;
    nodes.forEach((node) => {
      const id = node.getAttribute('data-suggest-id');
      if (!id) {
        return;
      }
      const rect = node.getBoundingClientRect();
      next.set(id, rect);
      if (!hadPrev) {
        return;
      }
      const was = prev.current.get(id);
      if (!was) {
        return;
      }
      const dy = was.top - rect.top;
      if (Math.abs(dy) < 1) {
        return;
      }
      node.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: MOVE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    });
    prev.current = next;
  }, [listRef, ids]);
}
