/** Windows File Explorer selection: Ctrl toggles, Shift takes a range, a drag box hits tiles it touches. */

export function applyCardSelect(state, ids, id, { ctrl = false, shift = false } = {}) {
  const order = (ids || []).map((value) => String(value));
  const key = String(id || '');
  const selected = new Set([...(state?.selected || [])].map(String));
  const anchor = state?.anchor ? String(state.anchor) : '';
  if (!key || !order.includes(key)) return { selected, anchor };
  if (shift && anchor && order.includes(anchor)) {
    const start = order.indexOf(anchor);
    const end = order.indexOf(key);
    const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
    const next = ctrl ? new Set(selected) : new Set();
    for (const item of range) next.add(item);
    return { selected: next, anchor };
  }
  if (ctrl) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    return { selected, anchor: key };
  }
  return { selected: new Set([key]), anchor: key };
}

export function bandHits(rects, band) {
  const left = Math.min(band.x0, band.x1);
  const right = Math.max(band.x0, band.x1);
  const top = Math.min(band.y0, band.y1);
  const bottom = Math.max(band.y0, band.y1);
  if (right - left < 4 && bottom - top < 4) return [];
  const hits = [];
  for (const row of rects || []) {
    if (row.right < left || row.left > right || row.bottom < top || row.top > bottom) continue;
    if (row.id) hits.push(String(row.id));
  }
  return hits;
}

export function selectionFromBand(base, hits, { ctrl = false } = {}) {
  if (!ctrl) return new Set((hits || []).map(String));
  const next = new Set([...(base || [])].map(String));
  for (const id of hits || []) next.add(String(id));
  return next;
}
