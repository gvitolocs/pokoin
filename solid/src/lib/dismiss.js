import { createEffect } from 'solid-js';

/**
 * Close a popover on an outside mousedown or Escape. Listeners exist only
 * while it is open (React kept one pair per toggle on every page, for every
 * click anywhere).
 */
export function dismissWhileOpen(open, getNode, close) {
  createEffect(open, (isOpen) => {
    if (!isOpen) return undefined;
    const onDoc = (event) => {
      const node = getNode();
      if (node && !node.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  });
}
