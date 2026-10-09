/**
 * Run `fn` once the page is idle after the first paint (requestIdleCallback,
 * or a short timeout where it is missing). Returns a cancel function.
 */
export function whenIdle(fn, timeout = 4000) {
  if (typeof window === 'undefined') return () => {};
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(() => fn(), { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 1500);
  return () => window.clearTimeout(id);
}
