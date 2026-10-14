/**
 * Persistent copy of public catalogue reads (IndexedDB `pokoin-local`), keyed
 * by the full public API URL: { url, etag, body, savedAt, bytes }.
 *
 * The body is the response text as it came off the wire (JSON or c1), decoded
 * on read. Measured in Chromium on 2026-10-11: putting the text cost 1-4 ms
 * where putting the decoded object cost up to 21 ms (74 ms at 4x CPU) of
 * main-thread structured clone, and took 5-8x the disk; reads were a tie
 * except the 228 KB c1v2 artist snapshot (21 ms text + decode vs 10 ms clone).
 *
 * LRU under LOCAL_STORE_CAP_BYTES (body length, ~bytes for JSON). Wiped when
 * the c1 dictionary version this build decodes with changes. Every call fails
 * open: no IndexedDB, private mode, quota, a blocked or hung open all resolve
 * to "nothing stored", and the caller reads the network as before.
 */

const DB_NAME = 'pokoin-local';
/** Bump to drop every stored row (row shape or key change). */
const SCHEMA = 1;
const BODIES = 'bodies';
const INFO = 'info';
const META = 'meta';
export const LOCAL_STORE_CAP_BYTES = 40 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 2000;
const TOUCH_DELAY_MS = 2000;

let cap = LOCAL_STORE_CAP_BYTES;
let version = '';
let opening = null;
let touches = new Map();
let touchTimer = 0;
let trimTimer = 0;

/** The c1 dictionary version stored bodies were decoded with; set once at boot. */
export function configureLocalStore({ dictionaryVersion, capBytes } = {}) {
  if (dictionaryVersion != null) version = `${SCHEMA}:${dictionaryVersion}`;
  if (capBytes > 0) cap = capBytes;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function openDb() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
    const settle = (db) => {
      clearTimeout(timer);
      resolve(db);
    };
    try {
      const req = globalThis.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore(BODIES);
        db.createObjectStore(INFO);
        db.createObjectStore(META);
      };
      req.onsuccess = () => settle(req.result);
      req.onerror = req.onblocked = () => settle(null);
    } catch {
      settle(null);
    }
  });
}

/** Drop every row when the stored version is not this build's. */
async function checkVersion(db) {
  const tx = db.transaction([BODIES, INFO, META], 'readwrite');
  const meta = tx.objectStore(META);
  const stored = await request(meta.get('version'));
  if (stored !== version) {
    tx.objectStore(BODIES).clear();
    tx.objectStore(INFO).clear();
    meta.put(version, 'version');
  }
  await done(tx);
}

/** The open database, or null when storage is unavailable (then always null). */
function db() {
  if (!opening) {
    opening = (async () => {
      try {
        if (!version || !globalThis.indexedDB) return null;
        const handle = await openDb();
        if (!handle) return null;
        handle.onversionchange = () => handle.close();
        await checkVersion(handle);
        return handle;
      } catch {
        return null;
      }
    })();
  }
  return opening;
}

/** The stored row for `url`, or null. Marks it used (batched). */
export async function localGet(url) {
  try {
    const handle = await db();
    if (!handle) return null;
    const tx = handle.transaction([BODIES, INFO], 'readonly');
    const [row, info] = await Promise.all([
      request(tx.objectStore(BODIES).get(url)),
      request(tx.objectStore(INFO).get(url)),
    ]);
    if (typeof row?.body !== 'string' || !info) return null;
    touch(url);
    return { url, etag: row.etag || '', body: row.body, savedAt: info.savedAt, bytes: info.bytes };
  } catch {
    return null;
  }
}

/** Store `body` for `url` (replacing any older copy), then trim to the cap. */
export async function localPut(url, body, etag = '', savedAt = Date.now()) {
  try {
    const handle = await db();
    if (!handle || typeof body !== 'string') return false;
    const tx = handle.transaction([BODIES, INFO], 'readwrite');
    tx.objectStore(BODIES).put({ body, etag }, url);
    tx.objectStore(INFO).put({ savedAt, usedAt: savedAt, bytes: body.length }, url);
    await done(tx);
    scheduleTrim();
    return true;
  } catch {
    // Quota: make room for next time; this copy is simply not kept.
    scheduleTrim(0);
    return false;
  }
}

/** A revalidation found the stored body unchanged: it is fresh as of `savedAt`. */
export function localConfirm(url, savedAt = Date.now()) {
  touch(url, savedAt);
}

function touch(url, savedAt = 0) {
  touches.set(url, Math.max(savedAt, touches.get(url) || 0));
  if (!touchTimer) touchTimer = setTimeout(flushTouches, TOUCH_DELAY_MS);
}

async function flushTouches() {
  touchTimer = 0;
  const batch = touches;
  touches = new Map();
  try {
    const handle = await db();
    if (!handle) return;
    const tx = handle.transaction(INFO, 'readwrite');
    const store = tx.objectStore(INFO);
    const now = Date.now();
    await Promise.all([...batch].map(async ([url, savedAt]) => {
      const info = await request(store.get(url));
      if (!info) return;
      store.put({ ...info, usedAt: now, savedAt: Math.max(info.savedAt, savedAt) }, url);
    }));
    await done(tx);
  } catch {
    /* LRU order is best effort */
  }
}

function scheduleTrim(delay = 1000) {
  clearTimeout(trimTimer);
  trimTimer = setTimeout(() => {
    trimTimer = 0;
    localTrim().catch(() => {});
  }, delay);
}

/** URLs to drop, least recently used first, to bring `rows` under 80% of `capBytes`. */
export function evictionPlan(rows, capBytes) {
  let total = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
  if (total <= capBytes) return [];
  const target = capBytes * 0.8;
  const out = [];
  for (const row of [...rows].sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= target) break;
    out.push(row.url);
    total -= row.bytes || 0;
  }
  return out;
}

/** Enforce the byte cap. Only the small info rows are read. */
export async function localTrim() {
  const handle = await db();
  if (!handle) return 0;
  const read = handle.transaction(INFO, 'readonly').objectStore(INFO);
  const [keys, infos] = await Promise.all([request(read.getAllKeys()), request(read.getAll())]);
  const drop = evictionPlan(infos.map((info, i) => ({ url: keys[i], ...info })), cap);
  if (!drop.length) return 0;
  const tx = handle.transaction([BODIES, INFO], 'readwrite');
  for (const url of drop) {
    tx.objectStore(BODIES).delete(url);
    tx.objectStore(INFO).delete(url);
  }
  await done(tx);
  return drop.length;
}

/** Forget one row (it no longer decodes). */
export async function localDelete(url) {
  try {
    const handle = await db();
    if (!handle) return;
    const tx = handle.transaction([BODIES, INFO], 'readwrite');
    tx.objectStore(BODIES).delete(url);
    tx.objectStore(INFO).delete(url);
    await done(tx);
  } catch {
    /* fail open */
  }
}

/** Drop every row (a newer c1 dictionary arrived at runtime). */
export async function localWipe() {
  try {
    const handle = await db();
    if (!handle) return;
    const tx = handle.transaction([BODIES, INFO], 'readwrite');
    tx.objectStore(BODIES).clear();
    tx.objectStore(INFO).clear();
    await done(tx);
  } catch {
    /* fail open */
  }
}

/** Row count and stored bytes, for tests and the benchmark. */
export async function localStats() {
  try {
    const handle = await db();
    if (!handle) return { rows: 0, bytes: 0, available: false };
    const infos = await request(handle.transaction(INFO, 'readonly').objectStore(INFO).getAll());
    return { rows: infos.length, bytes: infos.reduce((sum, info) => sum + (info.bytes || 0), 0), available: true };
  } catch {
    return { rows: 0, bytes: 0, available: false };
  }
}

/** Tests only: forget the open handle and pending work. */
export function resetLocalStoreForTests() {
  opening = null;
  touches = new Map();
  clearTimeout(touchTimer);
  clearTimeout(trimTimer);
  touchTimer = 0;
  trimTimer = 0;
  cap = LOCAL_STORE_CAP_BYTES;
}
