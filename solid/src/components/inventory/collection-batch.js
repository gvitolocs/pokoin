export const COLLECTION_BATCH_SIZE = 40;

/** Return the next number of tiles to reveal without exceeding the result count. */
export function nextCollectionBatch(shown, total) {
  return Math.min(Math.max(0, total), Math.max(0, shown) + COLLECTION_BATCH_SIZE);
}
