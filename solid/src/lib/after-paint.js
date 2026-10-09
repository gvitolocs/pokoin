/**
 * Run `fn` after the next paint: when React runs a passive effect (useEffect).
 * Solid effects run in the microtask after a change, before any paint, so an
 * effect that re-arms a scroll listener or measures the grid would act many
 * times per frame where the React page acts once. Returns a cancel function.
 */
export function afterPaint(fn) {
  if (typeof window === 'undefined') return () => {};
  let timer = 0;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(fn, 0);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
