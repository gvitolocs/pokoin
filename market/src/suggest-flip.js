// Slow enough to read as a row climbing the ranking (200 ms looked like a jump).
export const MOVE_MS = 420;
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * How far a row slides after a re-rank: the distance it moved up, or null.
 * Only rising rows move on screen. New rows, rows that dropped and rows that
 * left change in place, so a keystroke that keeps the same results changes
 * nothing visible.
 */
export function rowMotion(prevTop, nextTop) {
  if (!Number.isFinite(prevTop) || !Number.isFinite(nextTop)) return null;
  const dy = prevTop - nextTop;
  return dy >= 1 ? dy : null;
}

function stop(node) {
  if (typeof node?.getAnimations !== 'function') return;
  for (const running of node.getAnimations()) running.cancel();
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function rise(node, dy) {
  if (typeof node.animate !== 'function') return;
  stop(node);
  // Above the rows it passes on the way up.
  node.style.position = 'relative';
  node.style.zIndex = '1';
  const animation = node.animate(
    [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
    { duration: MOVE_MS, easing: EASING },
  );
  const settle = () => {
    node.style.position = '';
    node.style.zIndex = '';
  };
  animation.onfinish = settle;
  animation.oncancel = settle;
}

/**
 * Rows keep their card id; a row that ranks higher slides up into its new
 * slot. A keystroke cancels that row's in-flight slide and starts from where
 * it is, so rapid typing does not queue animations.
 * First paint does not animate (empty previous map).
 *
 * Framework-free: call `update(root)` after every list render (React
 * useSuggestFlip in suggest-hooks.js, Solid SearchBox) and `dispose()` on unmount.
 */
export function createSuggestFlip() {
  let prev = new Map();

  function update(root) {
    if (!root) {
      prev = new Map();
      return;
    }
    const animate = prev.size > 0 && !reducedMotion();
    const next = new Map();
    root.querySelectorAll('[data-suggest-id]').forEach((node) => {
      const id = node.getAttribute('data-suggest-id');
      if (!id) return;
      const top = node.getBoundingClientRect().top;
      next.set(id, top);
      if (!animate) return;
      const was = prev.get(id);
      const dy = was === undefined ? null : rowMotion(was, top);
      if (dy != null) {
        rise(node, dy);
      } else if (was === undefined || top - was >= 1) {
        // New or dropped: straight to its slot, no leftover slide.
        stop(node);
      }
    });
    prev = next;
  }

  // Runs on every row change in the Solid binding, so it must keep `prev`.
  function dispose() {}

  return { update, dispose };
}
