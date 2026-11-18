/**
 * The prefetch queue behind lib/local-prefetch.js, framework- and I/O-free.
 * Newest target first, at most `maxInFlight` loads at once, each started when
 * the browser is idle; a target loaded `repeatMs` ago is not queued again.
 * `abort` (a navigation) drops the queue and aborts every running load but one.
 */

/** True on Save-Data or a 2g connection: prefetch nothing. */
export function prefetchBlocked(connection) {
  return Boolean(connection?.saveData) || /(^|-)2g$/.test(String(connection?.effectiveType || ''));
}

const LANG = '([a-z]{2}(?:-[a-z]{2})?)';
const CARD = new RegExp(`^/marketplace/${LANG}/cards/([^/]+)(?:/([^/]+))?/?$`);
const VERSIONS = new RegExp(`^/marketplace/${LANG}/cards/([^/]+)(?:/([^/]+))?/versions/?$`);
const SET = /^\/marketplace\/sets\/([^/]+)\/?$/;
const ARTIST = new RegExp(`^/marketplace/${LANG}/artists/([^/]+)/?$`);
const SELLER = new RegExp(`^/marketplace/${LANG}/users/([^/]+)/?$`);

/**
 * The data behind a link path: `{ kind, key, ... }` for a card desk, version
 * page, set page, artist page or seller shop, else null. `base` is the game basename;
 * `cardId` maps a URL card id to the public id (provisional stamps).
 */
export function linkTarget(pathname, { base = '', cardId = (id) => id } = {}) {
  const path = base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
  let m = path.match(VERSIONS) || path.match(CARD);
  if (m) {
    const id = String(cardId(m[2]) || '');
    if (!/^\d+$/.test(id)) return null;
    const kind = path.match(VERSIONS) ? 'versions' : 'card';
    return { kind, key: `${kind}:${m[1]}:${id}`, id, lang: m[1], slug: m[3] || '' };
  }
  m = path.match(SET);
  if (m) return { kind: 'set', key: `set:${m[1]}`, slug: decodeURIComponent(m[1]) };
  m = path.match(ARTIST);
  if (m) return { kind: 'artist', key: `artist:${m[2]}`, slug: decodeURIComponent(m[2]) };
  m = path.match(SELLER);
  if (m) return { kind: 'seller', key: `seller:${m[2].toLowerCase()}`, handle: decodeURIComponent(m[2]) };
  return null;
}

/**
 * @param {object} io
 * @param {(target, signal: AbortSignal, intent: boolean) => Promise} io.load
 * @param {(fn: () => void) => void} io.idle
 * @param {() => boolean} [io.blocked]
 */
export function createPrefetchQueue({
  load,
  idle,
  blocked = () => false,
  now = Date.now,
  maxInFlight = 4,
  maxQueued = 24,
  repeatMs = 30_000,
}) {
  const queue = [];
  const running = new Map();
  const recent = new Map();
  let scheduled = false;

  function schedule() {
    if (scheduled || !queue.length) return;
    scheduled = true;
    idle(pump);
  }

  function pump() {
    scheduled = false;
    while (running.size < maxInFlight && queue.length) {
      const job = queue.shift();
      const controller = new AbortController();
      running.set(job.target.key, controller);
      Promise.resolve()
        .then(() => load(job.target, controller.signal, job.intent))
        .catch(() => {})
        .finally(() => {
          if (running.get(job.target.key) === controller) running.delete(job.target.key);
          if (!controller.signal.aborted) recent.set(job.target.key, now());
          if (recent.size > 256) recent.delete(recent.keys().next().value);
          schedule();
        });
    }
  }

  return {
    /** Queue `target` (newest first). False when it is skipped. */
    add(target, { intent = false } = {}) {
      if (!target || blocked()) return false;
      if (running.has(target.key) || now() - (recent.get(target.key) ?? -Infinity) < repeatMs) return false;
      const at = queue.findIndex((job) => job.target.key === target.key);
      if (at >= 0) queue.splice(at, 1);
      queue.unshift({ target, intent });
      queue.length = Math.min(queue.length, maxQueued);
      schedule();
      return true;
    },
    /** A navigation: drop the queue and abort running loads, except `keepKey`'s. */
    abort(keepKey = '') {
      queue.length = 0;
      for (const [key, controller] of running) {
        if (key === keepKey) continue;
        controller.abort();
        running.delete(key);
      }
    },
    /** Tests and the benchmark. */
    state: () => ({ queued: queue.map((job) => job.target.key), running: [...running.keys()] }),
  };
}
