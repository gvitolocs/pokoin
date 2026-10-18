import { liveInventoryListings } from './inventory-listings.js';

const STORAGE_KEY = 'pokoin.inventory-book.v1';
const RETAIN_MS = 15 * 60_000;
const FRESH_MS = 15_000;
const FIRST_PAGE = 200;
const PAGE_SIZE = 1000;

/** Private, tab-local book. Never put owner rows in the public catalog cache. */
export function createInventoryBookStore({ storage = () => globalThis.sessionStorage, now = Date.now, retryMs = 12_000 } = {}) {
  const books = new Map();
  const pending = new Map();
  const key = (uid, game) => JSON.stringify([uid, game]);

  function peek(uid, game) {
    if (!uid || !game) return null;
    const id = key(uid, game);
    let book = books.get(id);
    if (!book) {
      try {
        const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) || 'null');
        if (saved?.uid === uid && saved?.game === game && Array.isArray(saved.rows)) book = saved;
      } catch (_) { /* Storage is optional. */ }
    }
    if (!book || !Number.isFinite(book.savedAt) || now() - book.savedAt > RETAIN_MS) return null;
    books.delete(id);
    books.set(id, book);
    while (books.size > 4) books.delete(books.keys().next().value);
    return book;
  }

  function invalidate(uid, game) {
    const id = key(uid, game);
    books.delete(id);
    // A mutation must not let an older request overwrite its refreshed book.
    pending.delete(id);
    try {
      const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) || 'null');
      if (saved?.uid === uid && saved?.game === game) storage()?.removeItem(STORAGE_KEY);
    } catch (_) { /* Storage is optional. */ }
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

  function load(uid, game, { fetchPage, onUpdate = () => {}, force = false }) {
    if (!uid || !game) return Promise.resolve(null);
    const id = key(uid, game);
    const cached = peek(uid, game);
    if (cached) onUpdate(cached.rows);
    if (cached && !force && now() - cached.savedAt < FRESH_MS) return Promise.resolve(cached);
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
      for (const listener of work.listeners) listener(rows);
    };
    work.promise = (async () => {
      let data = await firstPage(fetchPage);
      let raw = data.listings || data.items || [];
      let offset = raw.length;
      let limit = FIRST_PAGE;
      const rows = [];
      const ids = new Set();
      for (;;) {
        for (const row of liveInventoryListings(raw)) {
          const rowId = String(row.id || row.listingId || '');
          if (rowId && ids.has(rowId)) continue;
          if (rowId) ids.add(rowId);
          rows.push(row);
        }
        const complete = raw.length < limit;
        publish([...rows], complete);
        if (complete || pending.get(id) !== work) break;
        limit = PAGE_SIZE;
        data = await fetchPage({ limit, offset });
        raw = data.listings || data.items || [];
        offset += raw.length;
      }
      if (pending.get(id) !== work) return null;
      const book = { uid, game, rows, savedAt: now() };
      books.set(id, book);
      while (books.size > 4) books.delete(books.keys().next().value);
      try {
        const text = JSON.stringify(book);
        if (text.length < 2 * 1024 * 1024) storage()?.setItem(STORAGE_KEY, text);
      } catch (_) { /* Memory still works if private mode or quota blocks storage. */ }
      return book;
    })().finally(() => {
      work.listeners.clear();
      if (pending.get(id) === work) pending.delete(id);
    });
    return work.promise;
  }

  function clear() {
    books.clear();
    pending.clear();
    try { storage()?.removeItem(STORAGE_KEY); } catch (_) { /* Optional storage. */ }
  }

  return { peek, load, invalidate, clear };
}

export const inventoryBooks = createInventoryBookStore();
