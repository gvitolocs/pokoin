// Slow enough to read as a row climbing the ranking; still snappy off the line (200 ms looked like a jump).
export const MOVE_MS = 620;
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

/** Translate already applied to a row, or 0 when it cannot be read (node tests). */
function currentTranslateY(node) {
  try {
    if (typeof getComputedStyle !== 'function' || typeof DOMMatrixReadOnly !== 'function') return 0;
    const transform = getComputedStyle(node)?.transform;
    if (!transform || transform === 'none') return 0;
    const y = new DOMMatrixReadOnly(transform).m42;
    return Number.isFinite(y) ? y : 0;
  } catch {
    return 0;
  }
}

/**
 * Rows keep their card id; a row whose layout slot moves up slides from where
 * it is on screen. The slot is the position without the running translate, so
 * a later paint for the same term does not cancel a rise that has not moved.
 * A keystroke that does move the slot cancels the in-flight slide and starts
 * again from the row's current visual position.
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
    const rootRect = root.getBoundingClientRect?.();
    const rootTop = rootRect?.top || 0;
    const scroll = root.scrollTop || 0;
    // Read every slot before writing: measuring after rise() would include
    // the transform this update is about to apply.
    const measured = [];
    root.querySelectorAll('[data-suggest-id]').forEach((node) => {
      const id = node.getAttribute('data-suggest-id');
      if (!id) return;
      const visual = node.getBoundingClientRect().top - rootTop + scroll;
      const slot = visual - currentTranslateY(node);
      measured.push({ node, id, visual, slot });
    });
    const animate = prev.size > 0 && !reducedMotion();
    const next = new Map();
    for (const { node, id, visual, slot } of measured) {
      next.set(id, slot);
      if (!animate) continue;
      const was = prev.get(id);
      if (was === undefined) {
        stop(node);
        continue;
      }
      if (Math.abs(slot - was) < 1) continue;
      if (slot < was) {
        // `visual - slot` is where the row is drawn relative to its new slot,
        // including an in-flight translate. A fresh rise has no transform, so
        // that offset is 0 and the distance is the slot change itself.
        const offset = visual - slot;
        const from = offset >= 1 ? offset : (was - slot);
        if (from >= 1) rise(node, from);
        else stop(node);
      } else {
        stop(node);
      }
    }
    prev = next;
  }

  // Runs on every row change in the Solid binding, so it must keep `prev`.
  function dispose() {}

  return { update, dispose };
}
