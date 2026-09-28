'use strict';

/**
 * Tiny in-memory Firestore Admin double for unit tests (never deployed).
 * Supports doc get/set(merge)/create/delete, where(==, in, array-contains)
 * on dotted paths, batches, transactions, serverTimestamp and increment.
 */

const INC = Symbol('increment');
const TS = Symbol('serverTimestamp');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function resolve(value, previous) {
  if (value && value[INC] !== undefined) return (Number(previous) || 0) + value[INC];
  if (value === TS) return new Date('2026-09-28T12:00:00Z');
  if (Array.isArray(value)) return value.map((row) => resolve(row));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = resolve(inner, previous?.[key]);
    return out;
  }
  return value;
}

function deepMerge(target, patch) {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && value[INC] === undefined && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = resolve(value, out[key]);
    }
  }
  return out;
}

function fieldAt(data, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
}

function createFirestore(seed = {}) {
  const store = new Map(); // "collection/id" -> data
  let autoId = 0;
  for (const [collectionName, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) store.set(`${collectionName}/${id}`, structuredClone(data));
  }

  function snapshot(ref) {
    const data = store.get(ref.path);
    return {
      id: ref.id,
      ref,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : structuredClone(data)),
    };
  }

  function writeDoc(ref, data, options = {}) {
    const current = store.get(ref.path);
    store.set(ref.path, options.merge ? deepMerge(current, data) : deepMerge({}, data));
  }

  function docRef(collectionName, id) {
    const docId = id || `auto_${(autoId += 1)}`;
    const ref = {
      id: docId,
      path: `${collectionName}/${docId}`,
      async get() { return snapshot(ref); },
      async set(data, options) { writeDoc(ref, data, options); },
      async create(data) {
        if (store.has(ref.path)) {
          const error = new Error('Document already exists');
          error.code = 6;
          throw error;
        }
        writeDoc(ref, data);
      },
      async delete() { store.delete(ref.path); },
    };
    return ref;
  }

  function query(collectionName, filters = [], max = Infinity) {
    return {
      where(field, op, value) { return query(collectionName, [...filters, { field, op, value }], max); },
      orderBy() { return query(collectionName, filters, max); },
      limit(n) { return query(collectionName, filters, n); },
      async get() {
        const docs = [];
        for (const [path, data] of store.entries()) {
          const [name, id] = path.split('/');
          if (name !== collectionName) continue;
          const ok = filters.every(({ field, op, value }) => {
            const actual = fieldAt(data, field);
            if (op === '==') return actual === value;
            if (op === 'in') return value.includes(actual);
            if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value);
            throw new Error(`fake firestore: unsupported op ${op}`);
          });
          if (ok) docs.push(snapshot(docRef(collectionName, id)));
        }
        return { docs: docs.slice(0, max), size: Math.min(docs.length, max) };
      },
    };
  }

  const firestore = {
    collection(name) {
      return {
        doc: (id) => docRef(name, id),
        ...query(name),
      };
    },
    batch() {
      const writes = [];
      return {
        set(ref, data, options) { writes.push(() => writeDoc(ref, data, options)); },
        async commit() { writes.forEach((write) => write()); },
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const transaction = {
        async get(ref) { return snapshot(ref); },
        set(ref, data, options) { writes.push(() => writeDoc(ref, data, options)); },
      };
      const result = await fn(transaction);
      writes.forEach((write) => write());
      return result;
    },
    dump(path) { return structuredClone(store.get(path)); },
    all(collectionName) {
      return [...store.entries()]
        .filter(([path]) => path.startsWith(`${collectionName}/`))
        .map(([path, data]) => ({ id: path.split('/')[1], ...structuredClone(data) }));
    },
  };

  const FieldValue = {
    serverTimestamp: () => TS,
    increment: (n) => ({ [INC]: n }),
  };
  const admin = { firestore: () => firestore };
  admin.firestore.FieldValue = FieldValue;
  return { admin, firestore };
}

module.exports = { createFirestore };
