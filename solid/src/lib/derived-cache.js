/**
 * Derivations that outlive one mount of a desk.
 *
 * MyPokoin's tabs are routes: switching away disposes the board and switching
 * back builds a new one over the *same* rows array (the book / holdings caches
 * hand back the identical array). Walking 1,500 rows again for the facets, the
 * duplicate groups or the desk split is pure repeat work, so each derivation
 * is remembered against the array it read. A new book is a new array, and an
 * optimistic edit creates one, so nothing stale survives.
 */

/** One remembered result per source array. */
export function memoizeByRows(compute) {
  const byRows = new WeakMap();
  return (rows) => {
    const keyable = rows !== null && typeof rows === 'object';
    if (keyable && byRows.has(rows)) return byRows.get(rows);
    const value = compute(rows);
    if (keyable) byRows.set(rows, value);
    return value;
  };
}

/** One remembered result per (first, second) pair; `first` keys the cache. */
export function memoizePair(compute) {
  const byFirst = new WeakMap();
  return (first, second) => {
    const keyable = first !== null && typeof first === 'object';
    if (keyable) {
      const hit = byFirst.get(first);
      if (hit && hit.second === second) return hit.value;
    }
    const value = compute(first, second);
    if (keyable) byFirst.set(first, { second, value });
    return value;
  };
}
