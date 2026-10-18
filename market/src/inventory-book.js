import { liveInventoryListings } from './inventory-listings.js';

/**
 * The signed-in seller's own listings book (MyPokoin), stale-while-revalidate:
 * a revisit paints the stored book at once, then one `stamp=1` read
 * (listing count + max(updated_at), Rust `owner_book_stamp`) says whether it
 * moved; only then is the whole book read again, and rows that did not change
 * keep their objects so the board keeps their DOM nodes.
 *
 * Private data: stored per uid + game in IndexedDB `pokoin-private`, never in
 * the public catalogue store, wiped on sign-out (`wipePrivateBooks`) and when
 * another account signs in (`retainOnly`).
 */
const LEGACY_SESSION_KEY = 'pokoin.inventory-book.v1';
const STALE_KEY = 'pokoin.inventory-book.stale';
/** Set once a book was persisted, so a sign-out wipe never opens IndexedDB for nothing. */
const STORED_KEY = 'pokoin.inventory-book.stored';
/** A persisted book older than this is not painted. */
const RETAIN_MS = 14 * 24 * 60 * 60_000;
/** No revalidation at all within this window of the last check. */
const FRESH_MS = 15_000;
/** A matching stamp is trusted this long; then the whole book is read again
 *  (catalogue enrichment such as image URLs does not move the stamp). */
const TRUST_MS = 6 * 60 * 60_000;
const FIRST_PAGE = 200;
const PAGE_SIZE = 1000;

function rowId(row) {
  return String(row?.id || row?.listingId || '');
}

/**
 * `next` with every unchanged row replaced by its `prev` object (same id,
 * same JSON). Returns `prev` itself when nothing changed at all, so a signal
 * set with it does not even notify.
 */
export function reconcileRows(prev, next) {
  if (!Array.isArray(prev) || !prev.length) return next;
  const old = new Map();
  for (const row of prev) {
    const id = rowId(row);
    if (id) old.set(id, row);
  }
  let same = prev.length === next.length;
  const out = next.map((row, index) => {
    const before = old.get(rowId(row));
    const kept = before && (before === row || JSON.stringify(before) === JSON.stringify(row)) ? before : row;
    if (kept !== prev[index]) same = false;
    return kept;
  });
  return same ? prev : out;
}

/** IndexedDB `pokoin-private`/`books`: { uid, game, stamp, savedAt, text }. Fails open. */
export function indexedDbBooks({ indexedDB = () => globalThis.indexedDB, timeoutMs = 1500 } = {}) {
  let opening = null;
  function open() {
    opening ||= new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const settle = (db) => { clearTimeout(timer); resolve(db); };
      try {
        const req = indexedDB().open('pokoin-private', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('books');
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); opening = null; };
          settle(db);
        };
        req.onerror = req.onblocked = () => settle(null);
      } catch (_) {
        settle(null);
      }
    });
    return opening;
  }
  async function run(mode, work) {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('books', mode);
        const result = work(tx.objectStore('books'));
        tx.oncomplete = () => resolve(result?.result ?? null);
        tx.onabort = tx.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }
  return {
    async get(id) {
      const saved = await run('readonly', (store) => store.get(id));
      if (!saved || typeof saved.text !== 'string') return null;
      try {
        return { uid: saved.uid, game: saved.game, stamp: saved.stamp || '', savedAt: saved.savedAt, rows: JSON.parse(saved.text) };
      } catch (_) {
        return null;
      }
    },
    put(id, book) {
      // The text, not the objects: a 1.3 MB book clones in ~10x the time.
      const text = JSON.stringify(book.rows);
      return run('readwrite', (store) => store.put({ uid: book.uid, game: book.game, stamp: book.stamp, savedAt: book.savedAt, text }, id));
    },
    delete(id) {
      return run('readwrite', (store) => store.delete(id));
    },
    /** Delete every book whose uid is not `uid` ('' deletes all). */
    retain(uid) {
      return run('readwrite', (store) => {
        if (!uid) return store.clear();
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (cursor.value?.uid !== uid) cursor.delete();
          cursor.continue();
        };
        return null;
      });
    },
  };
}

function readStaleBefore(storage) {
  try {
    return Number(storage()?.getItem(STALE_KEY)) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * `persist` holds books across reloads (IndexedDB by default; tests pass a
 * Map). `storage` only keeps the "a listing was written" mark.
 */
export function createInventoryBookStore({
  persist = indexedDbBooks(),
  storage = () => globalThis.localStorage,
  now = Date.now,
  retryMs = 12_000,
} = {}) {
  const books = new Map();
  const pending = new Map();
  const key = (uid, game) => JSON.stringify([uid, game]);
  // Books checked before a listing write must be read again in full: the
  // replica may not show the write to a stamp read yet.
  let staleBefore = readStaleBefore(storage);
  try { globalThis.sessionStorage?.removeItem(LEGACY_SESSION_KEY); } catch (_) { /* Optional. */ }

  function remember(id, book) {
    books.delete(id);
    books.set(id, book);
    while (books.size > 4) books.delete(books.keys().next().value);
    return book;
  }

  const usable = (book, uid, game) => book && book.uid === uid && book.game === game && Array.isArray(book.rows)
    && Number.isFinite(book.savedAt) && now() - book.savedAt <= RETAIN_MS;

  /** The book in memory, synchronously (any age the store still paints). */
  function peek(uid, game) {
    if (!uid || !game) return null;
    const id = key(uid, game);
    const book = books.get(id);
    if (!usable(book, uid, game)) return null;
    return remember(id, book);
  }

  /** The book in memory, else the persisted one. */
  async function restore(uid, game) {
    const memory = peek(uid, game);
    if (memory || !uid || !game) return memory;
    let saved = null;
    try { saved = await persist?.get(key(uid, game)); } catch (_) { /* Fails open. */ }
    if (!usable(saved, uid, game)) return null;
    const id = key(uid, game);
    // A full read may have landed while IndexedDB answered.
    return books.get(id) || remember(id, { ...saved, checkedAt: 0 });
  }

  function invalidate(uid, game) {
    const id = key(uid, game);
    // A mutation must not let an older request overwrite its refreshed book.
    pending.delete(id);
    const book = books.get(id);
    if (book) books.set(id, { ...book, checkedAt: 0, stale: true });
  }

  /** A listing was written somewhere: every book is read again in full (rows still paint). */
  function markStale() {
    staleBefore = now();
    pending.clear();
    for (const [id, book] of books) books.set(id, { ...book, stale: true });
    try { storage()?.setItem(STALE_KEY, String(staleBefore)); } catch (_) { /* Optional. */ }
  }

  function firstPage(fetchPage) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let attempts = 0;
      let failures = 0;
      let timer;
      const attempt = () => {
        attempts += 1;
        Promise.resolve().then(() => fetchPage({ limit: FIRST_PAGE, offset: 0 })).then((data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(data);
        }, (error) => {
          failures += 1;
          if (settled) return;
          if (attempts < 2) { clearTimeout(timer); attempt(); }
          else if (failures === attempts) { settled = true; clearTimeout(timer); reject(error); }
        });
      };
      timer = setTimeout(() => { if (!settled && attempts < 2) attempt(); }, retryMs);
      attempt();
    });
  }

  /**
   * Paint the stored book (`onUpdate(rows, complete)`, synchronously when it is in memory),
   * then revalidate: nothing within FRESH_MS, a `fetchStamp()` check while the
   * stamp is trusted, else the whole book. A cold load paints page by page;
   * a refresh of a painted book publishes once, complete and reconciled.
   */
  function load(uid, game, { fetchPage, fetchStamp, onUpdate = () => {}, force = false }) {
    if (!uid || !game) return Promise.resolve(null);
    const id = key(uid, game);
    const memory = peek(uid, game);
    if (memory) onUpdate(memory.rows, true);
    return (memory ? Promise.resolve(memory) : restore(uid, game).then((saved) => {
      if (saved) onUpdate(saved.rows, true);
      return saved;
    })).then((cached) => revalidate(uid, game, id, cached, { fetchPage, fetchStamp, onUpdate, force }));
  }

  function revalidate(uid, game, id, cached, { fetchPage, fetchStamp, onUpdate, force }) {
    const stale = !cached || cached.stale || (cached.checkedAt || cached.savedAt) <= staleBefore;
    if (cached && !force && !stale && now() - (cached.checkedAt || 0) < FRESH_MS) return Promise.resolve(cached);
    const running = pending.get(id);
    if (running) {
      running.listeners.add(onUpdate);
      return running.promise.finally(() => running.listeners.delete(onUpdate));
    }
    const work = { listeners: new Set([onUpdate]), promise: null };
    pending.set(id, work);
    const publish = (rows, complete) => {
      if (pending.get(id) !== work) return;
      // Keep the complete cached book while its replacement is still arriving.
      if (cached && !complete) return;
      for (const listener of work.listeners) listener(rows, complete);
    };
    work.promise = (async () => {
      if (cached && !force && !stale && cached.stamp && fetchStamp && now() - cached.savedAt < TRUST_MS) {
        let stamp = '';
        try { stamp = String(await fetchStamp() || ''); } catch (_) { /* Read the book instead. */ }
        if (pending.get(id) !== work) return null;
        if (stamp && stamp === cached.stamp) return remember(id, { ...cached, checkedAt: now() });
      }
      let data = await firstPage(fetchPage);
      const stamp = typeof data?.stamp === 'string' ? data.stamp : '';
      let raw = data.listings || data.items || [];
      let offset = raw.length;
      let limit = FIRST_PAGE;
      let rows = [];
      const ids = new Set();
      for (;;) {
        for (const row of liveInventoryListings(raw)) {
          const rid = rowId(row);
          if (rid && ids.has(rid)) continue;
          if (rid) ids.add(rid);
          rows.push(row);
        }
        const complete = raw.length < limit;
        if (complete && cached) rows = reconcileRows(cached.rows, rows);
        publish(complete ? rows : [...rows], complete);
        if (complete || pending.get(id) !== work) break;
        limit = PAGE_SIZE;
        data = await fetchPage({ limit, offset });
        raw = data.listings || data.items || [];
        offset += raw.length;
      }
      if (pending.get(id) !== work) return null;
      const book = remember(id, { uid, game, rows, stamp, savedAt: now(), checkedAt: now() });
      if (persist) {
        try { storage()?.setItem(STORED_KEY, '1'); } catch (_) { /* Optional. */ }
        persist.put(id, book)?.catch?.(() => {});
      }
      return book;
    })().finally(() => {
      work.listeners.clear();
      if (pending.get(id) === work) pending.delete(id);
    });
    return work.promise;
  }

  function stored() {
    try { return storage()?.getItem(STORED_KEY) === '1'; } catch (_) { return true; }
  }

  /** Another account signed in: forget every book that is not `uid`'s. */
  function retainOnly(uid) {
    for (const [id, book] of books) {
      if (book.uid !== uid) {
        books.delete(id);
        pending.delete(id);
      }
    }
    if (!stored()) return;
    try { persist?.retain(uid || '')?.catch?.(() => {}); } catch (_) { /* Optional. */ }
  }

  /** Sign-out: no book stays on this browser. */
  function clear() {
    books.clear();
    pending.clear();
    if (!stored()) return;
    try {
      persist?.retain('')?.catch?.(() => {});
      storage()?.removeItem(STORED_KEY);
    } catch (_) { /* Optional. */ }
  }

  return { peek, restore, load, invalidate, markStale, retainOnly, clear };
}

export const inventoryBooks = createInventoryBookStore();

/** A book was stored on this browser (it may answer from IndexedDB in a few ms). */
export function hasStoredBooks(storage = () => globalThis.localStorage) {
  try { return storage()?.getItem(STORED_KEY) === '1'; } catch (_) { return false; }
}

/** Per-seller settings cached next to the book (pricer source), wiped with it. */
const PRICER_KEY = 'pokoin.pricer-settings.v1';

export function readCachedPricerSettings(uid) {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(PRICER_KEY) || 'null');
    return saved?.uid && saved.uid === uid && saved.settings && typeof saved.settings === 'object' ? saved.settings : null;
  } catch (_) {
    return null;
  }
}

export function writeCachedPricerSettings(uid, settings) {
  if (!uid) return;
  try { globalThis.localStorage?.setItem(PRICER_KEY, JSON.stringify({ uid, settings: settings || {} })); } catch (_) { /* Optional. */ }
}

/** Sign-out / no session: drop every private seller cache on this browser. */
export function wipePrivateBooks() {
  inventoryBooks.clear();
  try {
    globalThis.localStorage?.removeItem(PRICER_KEY);
    globalThis.localStorage?.removeItem(STALE_KEY);
  } catch (_) { /* Optional. */ }
}

/** A (different) account is signed in: keep only its caches. */
export function retainPrivateBooks(uid) {
  inventoryBooks.retainOnly(uid);
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(PRICER_KEY) || 'null');
    if (saved && saved.uid !== uid) globalThis.localStorage?.removeItem(PRICER_KEY);
  } catch (_) { /* Optional. */ }
}
