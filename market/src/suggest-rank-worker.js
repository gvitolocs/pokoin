import { rankNames } from './suggest-rank.js';

let cachedPool = [];

self.onmessage = (event) => {
  const { id, query, pool } = event.data || {};
  if (Array.isArray(pool)) {
    cachedPool = pool;
  }
  self.postMessage({ id, ranked: rankNames(query, cachedPool) });
};
