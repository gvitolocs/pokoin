/** Rows that stay put while the tail cycles. The first five are the stable head. */
export const SUGGEST_ROTATE_HEAD = 5;
/** Ranked printings the tail may draw from, including the head. */
export const SUGGEST_ROTATE_POOL = 50;
/** Off until a visitor opts in. The popup then stays the ordinary top 20. */
export const SUGGEST_ROTATE_DEFAULT = false;

/**
 * `pokoinSuggestRotate` in localStorage: `'1'` on, `'0'` off.
 * Missing, unreadable, or any other value keeps the default.
 */
export function suggestRotateEnabled() {
  try {
    const flag = localStorage.getItem('pokoinSuggestRotate');
    if (flag === '1') return true;
    if (flag === '0') return false;
  } catch {
    // Private mode and node tests have no storage.
  }
  return SUGGEST_ROTATE_DEFAULT;
}

/**
 * How far the tail has paged for this search.
 * A later paint of the same term never advances `step` (progressive pages,
 * catalog hydration). Forward typing advances it only while the head five
 * card ids stay the same. Deleting, a new query, or a new head starts over.
 *
 * @param { { term?: string, headKey?: string, step?: number } | null | undefined } prev
 * @param { { term?: string, headKey?: string } } next
 * @returns {{ term: string, headKey: string, step: number }}
 */
export function nextRotateState(prev, { term, headKey } = {}) {
  const nextTerm = String(term ?? '');
  const nextHead = String(headKey ?? '');
  const prevTerm = String(prev?.term ?? '');
  const prevHead = String(prev?.headKey ?? '');
  const prevStep = Number.isFinite(prev?.step) ? prev.step : 0;
  if (nextTerm === prevTerm) {
    return { term: nextTerm, headKey: nextHead, step: prevStep };
  }
  const prevFold = prevTerm.trim().toLowerCase();
  const nextFold = nextTerm.trim().toLowerCase();
  const extended = prevFold.length > 0
    && nextFold.length > prevFold.length
    && nextFold.startsWith(prevFold);
  if (extended && nextHead && nextHead === prevHead) {
    return { term: nextTerm, headKey: nextHead, step: prevStep + 1 };
  }
  return { term: nextTerm, headKey: nextHead, step: 0 };
}

/**
 * Rows to show from an already-ranked list (index = rank).
 * Step 0, and any pool that already fits, is the ordinary prefix.
 * Otherwise the head stays and the tail window cycles through the rest,
 * then the chosen tail is put back in rank order. A short last page is
 * filled from the highest-ranked tail rows that are not already in it.
 */
export function rotateTail(rows, {
  step = 0,
  head = SUGGEST_ROTATE_HEAD,
  visible = 20,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const count = Math.max(0, visible);
  if (!step || list.length <= count) return list.slice(0, count);
  const headCount = Math.max(0, Math.min(head, count));
  const headRows = list.slice(0, headCount);
  const tail = list.slice(headCount);
  const slots = count - headCount;
  if (slots <= 0 || !tail.length) return list.slice(0, count);
  const pages = Math.ceil(tail.length / slots);
  const page = ((step % pages) + pages) % pages;
  const chosen = tail.slice(page * slots, page * slots + slots);
  if (chosen.length < slots) {
    const taken = new Set(chosen);
    for (const row of tail) {
      if (chosen.length >= slots) break;
      if (taken.has(row)) continue;
      taken.add(row);
      chosen.push(row);
    }
  }
  const order = new Map();
  for (let index = 0; index < list.length; index += 1) {
    if (!order.has(list[index])) order.set(list[index], index);
  }
  chosen.sort((a, b) => order.get(a) - order.get(b));
  return [...headRows, ...chosen];
}
