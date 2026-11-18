/** How long progressive pages of one search wait before sharing a repaint. */
export const SUGGEST_REPAINT_MS = 300;

/**
 * Coalesce repaints for one suggest generation.
 * The first page paints immediately. Later pages share one trailing bump:
 * while a timer is already waiting, further pages do nothing, and the timer
 * paints once. `flush` paints only if a page is still unpainted. `dispose`
 * drops the timer so a stale generation cannot paint.
 */
export function createRepaintGate({
  delay,
  schedule = setTimeout,
  cancel = clearTimeout,
  bump,
}) {
  let opened = false;
  let timer = null;

  function page() {
    if (!opened) {
      opened = true;
      bump();
      return;
    }
    if (timer != null) return;
    timer = schedule(() => {
      if (timer == null) return;
      timer = null;
      bump();
    }, delay);
  }

  function flush() {
    if (timer == null) return;
    const pending = timer;
    timer = null;
    cancel(pending);
    bump();
  }

  function dispose() {
    if (timer == null) return;
    const pending = timer;
    timer = null;
    cancel(pending);
  }

  return { page, flush, dispose };
}
