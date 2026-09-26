export const SUGGEST_HOVER_RATIO = 63 / 88;
export const SUGGEST_HOVER_MIN_PX = 721;

export function suggestHoverAllowed(viewportWidth, hoverFine = true) {
  return Number(viewportWidth) >= SUGGEST_HOVER_MIN_PX && hoverFine !== false;
}

/** Hero leftover JPEG first; suggest thumb (preview_ allowed) only if hero is empty. */
export function pickSuggestHoverSrc(hero, thumb) {
  return hero || thumb || '';
}

export function suggestHoverBox({
  viewportWidth,
  viewportHeight,
  panelLeft,
  panelRight,
  rowTop,
  rowHeight,
  gap = 12,
  pad = 8,
} = {}) {
  const vw = Number(viewportWidth) || 0;
  const vh = Number(viewportHeight) || 0;
  const ratio = SUGGEST_HOVER_RATIO;
  const maxH = Math.max(0, Math.min(vh - pad * 2, 340));
  let height = maxH;
  let width = height * ratio;

  const leftRoom = Number(panelLeft) - gap - pad;
  const rightRoom = vw - Number(panelRight) - gap - pad;

  let left = pad;
  let side = 'overlap-left';
  if (leftRoom >= width) {
    left = Number(panelLeft) - gap - width;
    side = 'left';
  } else if (rightRoom >= width) {
    left = Number(panelRight) + gap;
    side = 'right';
  } else if (leftRoom >= rightRoom && leftRoom >= 140) {
    width = leftRoom;
    height = width / ratio;
    left = pad;
    side = 'left-fit';
  } else if (rightRoom >= 140) {
    width = rightRoom;
    height = width / ratio;
    left = Number(panelRight) + gap;
    side = 'right-fit';
  } else {
    width = Math.min(vw * 0.42, maxH * ratio);
    height = width / ratio;
    left = pad;
    side = 'overlap-left';
  }

  if (height > maxH && maxH > 0) {
    height = maxH;
    width = height * ratio;
  }

  const rowMid = (Number(rowTop) || 0) + (Number(rowHeight) || 0) / 2;
  let top = rowMid - height / 2;
  top = Math.max(pad, Math.min(top, Math.max(pad, vh - height - pad)));

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
    side,
  };
}
