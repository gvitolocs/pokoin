import { useLayoutEffect } from 'react';

/**
 * Smallest share of the CSS title size a suggest name may shrink to. Past
 * this the `text-overflow: ellipsis` on `.suggest-copy strong` takes over,
 * so a very long name never turns into unreadable type.
 */
export const SUGGEST_TITLE_MIN_SCALE = 0.55;

const STEP_PX = 0.25;

function floorStep(px) {
  return Math.floor(px / STEP_PX) * STEP_PX;
}

/**
 * Font size (px) that fits a nowrap title `naturalWidth` px wide at `basePx`
 * into a `boxWidth` px box. Never grows past `basePx`; floors at
 * `minScale × basePx`. Text width scales linearly with font size.
 */
export function fitTitlePx(basePx, naturalWidth, boxWidth, minScale = SUGGEST_TITLE_MIN_SCALE) {
  if (!(basePx > 0) || !(naturalWidth > 0) || !(boxWidth > 0)) return basePx;
  if (naturalWidth <= boxWidth) return basePx;
  const floor = Math.ceil((basePx * minScale) / STEP_PX) * STEP_PX;
  return Math.max(floor, floorStep((basePx * boxWidth) / naturalWidth));
}

/**
 * Shrinks every `.suggest-copy strong` under `root` until its name (and the
 * phone ` - 006/021`) fits beside the artwork instead of running under it.
 * Reads every title before writing any, so a pass costs one layout.
 * `reset` re-reads the CSS size (breakpoint or web-font change).
 */
export function fitSuggestTitles(root, { reset = false } = {}) {
  if (!root?.querySelectorAll) return;
  const titles = [...root.querySelectorAll('.suggest-copy strong')];
  if (!titles.length) return;
  if (reset) {
    for (const el of titles) {
      el.style.fontSize = '';
      delete el.dataset.fitBase;
    }
  }
  const plan = titles.map((el) => {
    const current = parseFloat(getComputedStyle(el).fontSize) || 0;
    const stored = Number(el.dataset.fitBase);
    const base = stored > 0 ? stored : current;
    // scrollWidth is the full nowrap width even while the box clips it.
    const natural = current > 0 ? (el.scrollWidth * base) / current : 0;
    return { el, base, current, px: fitTitlePx(base, natural, el.clientWidth) };
  });
  for (const row of plan) {
    row.el.dataset.fitBase = String(row.base);
    if (row.px === row.current) continue;
    row.el.style.fontSize = row.px === row.base ? '' : `${row.px}px`;
  }
  // Glyph hinting is not perfectly linear: nudge any title still a pixel over.
  for (let pass = 0; pass < 3; pass += 1) {
    const over = plan.filter((row) => (
      row.el.scrollWidth > row.el.clientWidth
      && row.px > row.base * SUGGEST_TITLE_MIN_SCALE + STEP_PX
    ));
    if (!over.length) break;
    for (const row of over) {
      row.px -= STEP_PX * 2;
      row.el.style.fontSize = `${row.px}px`;
    }
  }
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
