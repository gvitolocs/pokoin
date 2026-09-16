/** Set-desk `_homepage.webp` loads: 12 at a time, Number / Official order first. */

export const SET_PREVIEW_BATCH = 12;

export function setDeskSkeletonCount(expansion, fallback = 24) {
  const n = Math.trunc(Number(expansion?.cardCount || expansion?.total || 0));
  if (Number.isFinite(n) && n > 0) {
    return Math.min(1000, n);
  }
  return fallback;
}

export function firstSetPreviewCount(total, batch = SET_PREVIEW_BATCH) {
  const size = Math.max(0, Math.trunc(Number(total) || 0));
  const step = Math.max(1, Math.trunc(Number(batch) || SET_PREVIEW_BATCH));
  if (size <= 0) {
    return 0;
  }
  return Math.min(size, step);
}

export function nextSetPreviewCount(ready, total, batch = SET_PREVIEW_BATCH) {
  const size = Math.max(0, Math.trunc(Number(total) || 0));
  if (size <= 0) {
    return 0;
  }
  const have = Math.max(0, Math.trunc(Number(ready) || 0));
  const step = Math.max(1, Math.trunc(Number(batch) || SET_PREVIEW_BATCH));
  if (have >= size) {
    return size;
  }
  if (have <= 0) {
    return Math.min(size, step);
  }
  return Math.min(size, have + step);
}
