/**
 * Local-first reads of public catalogue GETs: memory, then the persistent
 * store (local-store.js), then the network, stale-while-revalidate.
 *
 * - Only `localStorable` URLs come here: public catalogue routes with no
 *   personal or live-price content. Cart, checkout, orders, wallet, profile,
 *   listings, scan, messages and every authenticated call never do.
 * - A stored copy younger than `maxStaleMs` answers at once; when it is older
 *   than FRESH_MS the network is asked again in the background (through the
 *   browser HTTP cache, so the browser sends its own If-None-Match: a script
 *   cannot, the API's CORS does not allow that header). An unchanged body only
 *   refreshes the row's date; a changed one is stored, kept, and announced to
 *   `subscribe` listeners and the read's `onUpdate`.
 * - A copy older than `maxStaleMs` waits for the network, and still answers
 *   when the network fails. One the revalidation finds gone (404 / 410) is
 *   dropped, so the next read shows the answer.
 * - A read that may show an old copy gives the store STORE_WAIT_MS (an open
 *   database answers in under 1 ms; opening it takes ~7 ms, creating it on a
 *   first visit ~70 ms) before asking the network too; one that may not asks
 *   the network at once. Either way the first usable answer wins.
 * - Prefetch reads (`prefetch: true`) take a stored copy of any age without
 *   asking the network again (the view revalidates when it opens), and can be
 *   aborted by their `signal` until a real read joins the same request.
 *
 * Framework-free and I/O-injected; api.js wires it to fetch and IndexedDB.
 */

/** A copy this young is not asked about again. */
export const FRESH_MS = 30_000;
/** Shown before the network answers only when the view takes `onUpdate`. */
export const MAX_STALE_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a read waits for the store before asking the network as well. */
const STORE_WAIT_MS = 25;
const SLOW = Symbol('slow store');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms, SLOW));
const MEMORY_ROWS = 64;
const MEMORY_CHARS = 12 * 1024 * 1024;

const ALWAYS = () => true;
/** Public catalogue routes kept on disk, with the queries that qualify. */
const STORABLE = {
  '/api/marketplace-list': ALWAYS, // set / artist / name snapshots
  '/api/marketplace-card-page': (q) => !q.has('includeOffers'), // offers are live listings
  '/api/marketplace-related': ALWAYS,
  '/api/marketplace-version-set': ALWAYS,
  // The set index (no slug), and the 1-row nationality read every card desk makes.
  '/api/marketplace-expansion-page': (q) => (!q.has('slug') && !q.has('expansionName')) || q.get('limit') === '1',
  // Artist index; every card desk reads it once for the artist cover.
  '/api/marketplace-artist-cards': (q) => q.get('summaries') === '1',
  '/api/dictionary': ALWAYS,
};

export function localStorable(url) {
  try {
    const parsed = new URL(url, 'https://api.pokoin.com');
    return Boolean(STORABLE[parsed.pathname]?.(parsed.searchParams));
  } catch {
    return false;
  }
}

/** A store call that may throw or reject: failures are ignored. */
function quietly(call) {
  try {
    return Promise.resolve(call()).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function abortError() {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/**
 * @param {object} io
 * @param {(url: string, init: object) => Promise<{text: string, etag?: string}>} io.fetchText
 * @param {{get, put, confirm, remove}} io.store  every method may fail; failures are misses
 * @param {(text: string) => any} io.decode  response text to the value callers see
 */
export function createLocalReader({ fetchText, store, decode, now = Date.now, storeWaitMs = STORE_WAIT_MS }) {
  const memory = new Map();
  let memoryChars = 0;
  const inflight = new Map();
  const revalidating = new Map();
  const listeners = new Map();

  function remember(url, text, savedAt, value) {
    const old = memory.get(url);
    if (old) memoryChars -= old.text.length;
    memory.delete(url);
    memory.set(url, { text, savedAt, value });
    memoryChars += text.length;
    while (memory.size > MEMORY_ROWS || (memoryChars > MEMORY_CHARS && memory.size > 1)) {
      const [oldest, row] = memory.entries().next().value;
      memory.delete(oldest);
      memoryChars -= row.text.length;
    }
  }

  function notify(url, value) {
    for (const fn of listeners.get(url) || []) {
      try {
        fn(value);
      } catch {
        /* one listener never breaks the others */
      }
    }
  }

  function tryDecode(text) {
    try {
      return { value: decode(text) };
    } catch {
      return null;
    }
  }

  /** The decoded body, stored and kept; listeners hear about a change. */
  function land(url, text, etag) {
    const before = memory.get(url)?.text;
    const value = decode(text);
    const at = now();
    remember(url, text, at, value);
    quietly(() => store.put(url, text, etag, at));
    if (before !== undefined && before !== text) notify(url, value);
    return value;
  }

  /** A copy that is gone (404 / 410) is not shown again: the next read asks the network. */
  function forget(url) {
    const row = memory.get(url);
    if (row) {
      memory.delete(url);
      memoryChars -= row.text.length;
    }
    quietly(() => store.remove(url));
  }

  /**
   * Ask the network again; resolves to the new value, or undefined when
   * unchanged or failed. A read already asking the network (a route preload
   * the view did not wait for) is this revalidation: it lands the answer itself.
   */
  function revalidate(url) {
    let job = revalidating.get(url);
    if (!job) {
      const old = memory.get(url)?.text;
      const running = inflight.get(url);
      if (running) {
        running.adopted = true;
        running.readers += 1;
      }
      job = (running
        ? running.promise.then(() => {
          const row = memory.get(url);
          return row && row.text !== old ? row.value : undefined;
        })
        : Promise.resolve()
          .then(() => fetchText(url, { priority: 'low' }))
          .then(({ text, etag }) => {
            if (text === old) {
              const row = memory.get(url);
              if (row) row.savedAt = now();
              quietly(() => store.confirm(url, now()));
              return undefined;
            }
            return land(url, text, etag);
          }))
        .catch((err) => {
          if (err?.status === 404 || err?.status === 410) forget(url);
          return undefined;
        })
        .finally(() => revalidating.delete(url));
      revalidating.set(url, job);
    }
    return job;
  }

  /** A prefetch only needs a copy: the view revalidates when it opens. */
  function serve(url, row, onUpdate, prefetch) {
    if (!prefetch && now() - row.savedAt > FRESH_MS) {
      const job = revalidate(url);
      if (onUpdate) job.then((value) => value !== undefined && onUpdate(value));
    }
    return row.value;
  }

  function network(url, { prefetch, signal, priority = prefetch ? 'low' : undefined }, fallback) {
    let job = inflight.get(url);
    if (!job) {
      const controller = new AbortController();
      job = { adopted: !prefetch, controller, readers: 0 };
      job.promise = Promise.resolve()
        .then(() => fetchText(url, { signal: controller.signal, priority }))
        .then(({ text, etag }) => land(url, text, etag))
        .finally(() => inflight.delete(url));
      inflight.set(url, job);
    } else if (!prefetch) {
      job.adopted = true;
    }
    job.readers += 1;
    if (prefetch && signal) {
      signal.addEventListener('abort', () => {
        if (!job.adopted) job.controller.abort();
      }, { once: true });
    }
    return job.promise.catch((err) => {
      // The network or the origin failed: the stored copy stands in. A 4xx
      // (a card that is gone) is an answer, not a failure.
      const answered = err?.status >= 400 && err.status < 500;
      if (fallback && !answered && err?.name !== 'AbortError' && !job.controller.signal.aborted) {
        const decoded = tryDecode(fallback.text);
        if (decoded) {
          remember(url, fallback.text, fallback.savedAt, decoded.value);
          return decoded.value;
        }
      }
      throw err;
    });
  }

  /** A stored row as a value to show (`value`), a stand-in for failures (`stale`), or null. */
  function fromRow(url, row, maxStaleMs) {
    if (!row || typeof row.body !== 'string') return null;
    const decoded = tryDecode(row.body);
    if (!decoded) {
      quietly(() => store.remove(url));
      return null;
    }
    if (now() - row.savedAt > maxStaleMs) return { stale: { text: row.body, savedAt: row.savedAt } };
    return { value: decoded.value, text: row.body, savedAt: row.savedAt };
  }

  /**
   * The store did not answer within storeWaitMs (opening, or being created on
   * a first visit): the network is asked too, and the first usable answer
   * wins. A stored copy that wins is revalidated by that same request.
   */
  function raceStore(url, options, pending, maxStaleMs) {
    const net = network(url, options, null);
    let shownText;
    const local = pending.then((row) => {
      const usable = fromRow(url, row, maxStaleMs);
      if (!usable?.value || memory.has(url)) throw new Error('no stored copy');
      remember(url, usable.text, usable.savedAt, usable.value);
      shownText = usable.text;
      // A copy this fresh needs no revalidation: drop the request if it is ours alone.
      const job = inflight.get(url);
      if (now() - usable.savedAt <= FRESH_MS && job?.readers === 1) job.controller.abort();
      return usable.value;
    });
    if (options.onUpdate) {
      net.then((value) => {
        if (shownText !== undefined && memory.get(url)?.text !== shownText) options.onUpdate(value);
      }, () => {});
    }
    return Promise.any([local, net]).catch(async () => {
      try {
        return await net;
      } catch (err) {
        const answered = err?.status >= 400 && err.status < 500;
        const stale = answered || err?.name === 'AbortError' ? null : fromRow(url, await pending, Infinity);
        if (!stale?.value) throw err;
        remember(url, stale.text, stale.savedAt, stale.value);
        return stale.value;
      }
    });
  }

  /**
   * The value for `url`. `fresh` skips memory and store (the answer is still
   * stored). `maxStaleMs` (default FRESH_MS, or MAX_STALE_MS with `onUpdate`
   * or `prefetch`) is the oldest copy shown before the network answers.
   */
  async function read(url, options = {}) {
    const { fresh = false, onUpdate, prefetch = false, signal } = options;
    const maxStaleMs = options.maxStaleMs ?? (onUpdate || prefetch ? MAX_STALE_MS : FRESH_MS);
    if (signal?.aborted) throw abortError();
    let fallback = null;
    const hit = memory.get(url);
    if (hit) {
      if (!fresh && now() - hit.savedAt <= maxStaleMs) {
        memory.delete(url);
        memory.set(url, hit);
        return serve(url, hit, onUpdate, prefetch);
      }
      fallback = hit;
    }
    if (!fresh && !hit) {
      const pending = quietly(() => store.get(url));
      // Prefetches wait for the store: they are not in a hurry, and a stored copy
      // saves a request. A read that only takes a copy younger than FRESH_MS asks
      // the network at once (the store still wins when it holds one, and still
      // stands in when the network fails); the others give the store a head start.
      const row = prefetch
        ? await pending
        : maxStaleMs <= FRESH_MS ? SLOW : await Promise.race([pending, wait(storeWaitMs)]);
      if (row === SLOW) return raceStore(url, options, pending, maxStaleMs);
      const raced = memory.get(url);
      if (raced && now() - raced.savedAt <= maxStaleMs) return serve(url, raced, onUpdate, prefetch);
      const usable = fromRow(url, row, maxStaleMs);
      if (usable?.value) {
        remember(url, usable.text, usable.savedAt, usable.value);
        return serve(url, memory.get(url), onUpdate, prefetch);
      }
      fallback = usable?.stale || null;
    }
    return network(url, options, fallback);
  }

  return {
    read,
    /** The value in memory for `url` (any age), or undefined. Never does I/O. */
    peek: (url) => memory.get(url)?.value,
    /** True when memory holds a copy of `url` younger than FRESH_MS. */
    fresh: (url) => {
      const row = memory.get(url);
      return Boolean(row) && now() - row.savedAt <= FRESH_MS;
    },
    /** A real read now depends on this in-flight prefetch: aborts no longer apply. */
    adopt: (url) => {
      const job = inflight.get(url);
      if (job) job.adopted = true;
    },
    /** Run `fn(value)` whenever `url` comes back from the network changed. */
    subscribe(url, fn) {
      if (!listeners.has(url)) listeners.set(url, new Set());
      listeners.get(url).add(fn);
      return () => {
        const set = listeners.get(url);
        set?.delete(fn);
        if (set && !set.size) listeners.delete(url);
      };
    },
    /** Tests only. */
    clearMemory() {
      memory.clear();
      memoryChars = 0;
    },
  };
}
