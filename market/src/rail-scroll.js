const EDGE = 8;

export function railAtStart(node) {
  return !node || (Number(node.scrollLeft) || 0) <= EDGE;
}

export function railAtEnd(node) {
  if (!node) {
    return true;
  }
  const max = Math.max(0, Number(node.scrollWidth) - Number(node.clientWidth));
  return max <= EDGE || (Number(node.scrollLeft) || 0) >= max - EDGE;
}

export function nextRailScrollLeft(node, direction) {
  if (!node) {
    return 0;
  }
  const page = Math.max(220, Number(node.clientWidth) * 0.8);
  const max = Math.max(0, Number(node.scrollWidth) - Number(node.clientWidth));
  const left = Number(node.scrollLeft) || 0;
  if (max <= 0) {
    return 0;
  }
  return Math.min(max, Math.max(0, left + direction * page));
}

export function stepRail(node, direction) {
  if (!node) {
    return;
  }
  node.scrollTo({ left: nextRailScrollLeft(node, direction), behavior: 'smooth' });
}

export function syncRailControls(track) {
  if (!track) {
    return;
  }
  const wrap = track.parentElement;
  if (!wrap) {
    return;
  }
  const prev = wrap.querySelector('.rail-prev');
  const next = wrap.querySelector('.rail-next');
  const start = railAtStart(track);
  const end = railAtEnd(track);
  if (prev) {
    prev.disabled = start;
    prev.setAttribute('aria-disabled', start ? 'true' : 'false');
  }
  if (next) {
    next.disabled = end;
    next.setAttribute('aria-disabled', end ? 'true' : 'false');
  }
}

export function bindRailControls(node) {
  if (!node) {
    return () => {};
  }
  const update = () => syncRailControls(node);
  update();
  node.addEventListener('scroll', update, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  observer?.observe(node);
  return () => {
    node.removeEventListener('scroll', update);
    observer?.disconnect();
  };
}
