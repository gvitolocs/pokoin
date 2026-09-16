import {
  NAME_POOL,
  mergeRanked,
  rankConcurrency,
  rankNames,
  splitPool,
} from './suggest-rank.js';

let workers = [];
const chunkKeys = new WeakMap();

function chunkKey(chunk) {
  const first = chunk?.[0];
  const last = chunk?.[(chunk?.length || 1) - 1];
  return `${chunk?.length || 0}:${first?.compact || ''}:${last?.compact || ''}`;
}

export function warmupSuggestRankWorkers() {
  if (typeof Worker === 'undefined') {
    return;
  }
  if (workers.length) {
    return;
  }
  const n = rankConcurrency();
  workers = Array.from({ length: n }, () => new Worker(
    new URL('./suggest-rank-worker.js', import.meta.url),
    { type: 'module' },
  ));
  const chunks = splitPool(NAME_POOL, workers.length);
  chunks.forEach((chunk, index) => {
    const worker = workers[index];
    worker.postMessage({ id: `init-${index}`, query: '', pool: chunk });
    chunkKeys.set(worker, chunkKey(chunk));
  });
}

/** Vite workers each import the 10k-name catalog. Do not block Meili on that. */
const WORKER_RANK_MS = 80;

export function rankChunkOnWorker(query, chunk, index = 0) {
  if (!workers.length) {
    warmupSuggestRankWorkers();
  }
  if (!workers.length) {
    return rankNames(query, chunk);
  }
  const worker = workers[index % workers.length];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ranked) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(ranked);
    };
    const id = `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
    const onMessage = (event) => {
      if (event.data?.id !== id) {
        return;
      }
      finish(event.data.ranked);
    };
    const onError = () => finish(rankNames(query, chunk));
    const timer = setTimeout(() => finish(rankNames(query, chunk)), WORKER_RANK_MS);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const payload = { id, query };
    const key = chunkKey(chunk);
    if (chunkKeys.get(worker) !== key) {
      payload.pool = chunk;
      chunkKeys.set(worker, key);
    }
    worker.postMessage(payload);
  });
}

export async function rankNamesOnWorkers(query, pool = NAME_POOL) {
  warmupSuggestRankWorkers();
  if (!workers.length) {
    return rankNames(query, pool);
  }
  const chunks = splitPool(pool, workers.length);
  const parts = await Promise.all(chunks.map((chunk, index) => rankChunkOnWorker(query, chunk, index)));
  return mergeRanked(parts);
}
