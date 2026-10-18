/**
 * Image URLs that failed on this browser and the sibling that loaded instead
 * (a missing `_homepage.webp` thumb, a satellite scan stored as .webp but
 * listed as .jpg). Without it every visit asked for the missing file first and
 * the <img> swapped source in front of the visitor; with it a revisit paints
 * the working URL at once.
 *
 * localStorage `pokoin.imgFallback.v1`: { [failedUrl]: [workingUrl, savedAt] },
 * entries kept 7 days, at most 1500, written in one batch per tick.
 */
const KEY = 'pokoin.imgFallback.v1';
/** Every sibling failed: paint the missing-card scan without asking again. */
export const DEAD_IMAGE = 'about:dead';
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX = 1500;

let memo = null;
let dirty = false;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function load() {
  if (memo) return memo;
  memo = new Map();
  try {
    const saved = JSON.parse(storage()?.getItem(KEY) || '{}');
    const now = Date.now();
    for (const [from, value] of Object.entries(saved || {})) {
      if (Array.isArray(value) && typeof value[0] === 'string' && now - Number(value[1] || 0) < (Number(value[2]) || KEEP_MS)) {
        memo.set(from, value);
      }
    }
  } catch {
    /* corrupt or blocked storage: start empty */
  }
  return memo;
}

function flush() {
  dirty = false;
  const map = load();
  while (map.size > MAX) map.delete(map.keys().next().value);
  try {
    storage()?.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* quota / private mode: memory still works */
  }
}

/** The URL this browser loaded instead of `url`, or `url` itself. */
export function workingImage(url) {
  const key = String(url || '');
  if (!key) return key;
  return load().get(key)?.[0] || key;
}

/** `failed` did not load; `working` did (or is the next one to try). */
export function rememberImageFallback(failed, working, { keepMs = 0 } = {}) {
  const from = String(failed || '');
  const to = String(working || '');
  if (!from || !to || from === to) return;
  const map = load();
  if (map.get(from)?.[0] === to) return;
  map.delete(from);
  map.set(from, keepMs ? [to, Date.now(), keepMs] : [to, Date.now()]);
  if (dirty) return;
  dirty = true;
  queueMicrotask(flush);
}

/** Tests only. */
export function resetImageFallbackMemo() {
  memo = null;
  dirty = false;
}
