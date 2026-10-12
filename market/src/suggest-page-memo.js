/**
 * PIPELINE BLOCK: typeahead page memo (SPA)
 * -----------------------------------------
 * The search bar pages printings for every lookup of the typed text, and a
 * keystroke starts those lookups again: typing `mimikyu gx` asked for the
 * `mimikyu` pages four times, a few tens of milliseconds apart. A page that
 * already came back is answered from memory for a minute instead.
 *
 * Only finished answers are kept. A request in flight still belongs to the
 * keystroke that started it and is aborted with it, so nothing here changes
 * which rows the popup shows, only how often the server is asked for them.
 *
 * Revert: call the fetcher directly in SearchBox.jsx.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX = 400;

function keyOf(query, options) {
  const rest = {};
  for (const name of Object.keys(options || {}).sort()) {
    if (name === 'signal') continue;
    const value = options[name];
    if (value !== undefined) rest[name] = value;
  }
  return `${String(query ?? '')}\0${JSON.stringify(rest)}`;
}

/**
 * `(query, options) => Promise<page>` with the pages remembered by query and
 * options (the abort signal is not part of a page's identity).
 */
export function createPageMemo(fetchPage, { ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
  const pages = new Map();
  function memo(query, options = {}) {
    const key = keyOf(query, options);
    const hit = pages.get(key);
    if (hit) {
      if (now() - hit.at < ttlMs) {
        // Most recently used last, so the oldest entry is the one dropped.
        pages.delete(key);
        pages.set(key, hit);
        return Promise.resolve(hit.page);
      }
      pages.delete(key);
    }
    return Promise.resolve(fetchPage(query, options)).then((page) => {
      pages.set(key, { at: now(), page });
      while (pages.size > max) pages.delete(pages.keys().next().value);
      return page;
    });
  }
  memo.clear = () => pages.clear();
  memo.size = () => pages.size;
  return memo;
}
