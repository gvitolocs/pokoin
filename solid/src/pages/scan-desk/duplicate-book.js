import { createSignal } from 'solid-js';
import { loadOwnerBook } from '../../lib/owner-book.js';

// One owner-book read per uid + game for every scan row (inventoryBooks
// caches the book itself; this only keeps the rows as a signal).
const books = new Map();

/** The signed-in seller's book for `gameId`, or null until it arrives. Reactive. */
export function scanOwnerBook(uid, gameId) {
  if (!uid || !gameId) return null;
  const key = `${uid}:${gameId}`;
  let entry = books.get(key);
  if (!entry) {
    const [rows, setRows] = createSignal(null);
    entry = { rows };
    books.set(key, entry);
    // Never written during the render that asked for it.
    queueMicrotask(() => {
      loadOwnerBook(uid, gameId, (next) => setRows(() => next)).catch(() => {});
    });
  }
  return entry.rows();
}
