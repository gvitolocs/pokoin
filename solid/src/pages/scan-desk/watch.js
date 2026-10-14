import { createEffect, createMemo } from 'solid-js';

function sameList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * React `useEffect(fn, deps)`: `apply(deps, prev)` runs on mount and again
 * only when one of the listed values changes (Object.is per entry), not on
 * every change of the objects they were read from. `apply` is untracked and
 * may return a cleanup, like an effect.
 */
export function watch(deps, apply) {
  const key = createMemo(deps, { equals: sameList });
  createEffect(key, apply);
}
