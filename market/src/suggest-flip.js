const MOVE_MS = 200;
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

function retarget(node, keyframes) {
  if (!node || typeof node.animate !== 'function') return;
  if (typeof node.getAnimations === 'function') {
    for (const running of node.getAnimations()) running.cancel();
  }
  node.animate(keyframes, { duration: MOVE_MS, easing: EASING, fill: 'both' });
}

/**
 * Rows keep their card id and slide to the new slot.
 * A keystroke cancels the in-flight motion and starts from the current
 * position, so rapid typing does not queue animations.
 * First paint does not animate (empty previous map).
 *
 * Framework-free: call `update(root)` after every list render (React
 * useSuggestFlip in suggest-hooks.js, Solid SearchBox) and `dispose()` on unmount.
 */
export function createSuggestFlip() {
  let prev = new Map();
  let ghosts = [];
  function dispose() {
    for (const ghost of ghosts) ghost.remove();
    ghosts = [];
  }
  function update(root) {
    if (!root) {
      prev = new Map();
      return;
    }
    for (const ghost of ghosts) ghost.remove();
    ghosts = [];
    const nodes = root.querySelectorAll('[data-suggest-id]');
    const next = new Map();
    const hadPrev = prev.size > 0;
    const seen = new Set();
    nodes.forEach((node) => {
      const id = node.getAttribute('data-suggest-id');
      if (!id) return;
      seen.add(id);
      const rect = node.getBoundingClientRect();
      next.set(id, { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
      if (!hadPrev) return;
      const was = prev.get(id);
      if (!was) {
        retarget(node, [
          { opacity: 0, transform: 'scale(0.96)' },
          { opacity: 1, transform: 'scale(1)' },
        ]);
        return;
      }
      const dy = was.top - rect.top;
      if (Math.abs(dy) < 1) return;
      const rising = dy > 12;
      const falling = dy < -12;
      const scale = rising ? 1.04 : falling ? 0.98 : 1;
      retarget(node, [
        { transform: `translateY(${dy}px) scale(${scale})` },
        { transform: 'translateY(0) scale(1)' },
      ]);
    });
    if (hadPrev) {
      for (const [id, was] of prev) {
        if (seen.has(id) || !was.node) continue;
        const ghost = was.node.cloneNode(true);
        ghost.removeAttribute('id');
        ghost.setAttribute('data-suggest-leaving', id);
        ghost.style.position = 'fixed';
        ghost.style.left = `${was.left}px`;
        ghost.style.top = `${was.top}px`;
        ghost.style.width = `${was.width}px`;
        ghost.style.height = `${was.height}px`;
        ghost.style.margin = '0';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '4';
        document.body.appendChild(ghost);
        ghosts.push(ghost);
        const animation = ghost.animate([
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(0.97)' },
        ], { duration: MOVE_MS, easing: EASING, fill: 'both' });
        animation.onfinish = () => {
          ghost.remove();
          ghosts = ghosts.filter((node) => node !== ghost);
        };
      }
    }
    nodes.forEach((node) => {
      const id = node.getAttribute('data-suggest-id');
      if (!id || !next.has(id)) return;
      next.get(id).node = node;
    });
    prev = next;
  }
  return { update, dispose };
}
