/**
 * Price-suggestion bookkeeping for the Scan Desk prices effect.
 *
 * `pricesAsked` holds `${rowId}:${signature}` keys already asked, and
 * `suggestedFor` the signature each row was last asked for. A run claims its
 * rows up front; when it is cancelled (any list change re-runs the effect) or
 * throws, the rows it never settled are released so the next run asks again.
 */

export function priceKey(rowId, signature) {
  return `${rowId}:${signature}`;
}

/** Marks `rows` asked and returns them. */
export function claimRows(rows, { pricesAsked, suggestedFor, signatureOf }) {
  for (const row of rows) {
    const signature = signatureOf(row);
    pricesAsked.add(priceKey(row.id, signature));
    suggestedFor.set(row.id, signature);
  }
  return rows;
}

/** Forgets every claimed row whose id is not in `settled`; returns the released rows. */
export function releaseUnsettled(claimed, settled, { pricesAsked, suggestedFor, signatureOf }) {
  const released = [];
  for (const row of claimed) {
    if (settled.has(row.id)) continue;
    const signature = signatureOf(row);
    pricesAsked.delete(priceKey(row.id, signature));
    if (suggestedFor.get(row.id) === signature) suggestedFor.delete(row.id);
    released.push(row);
  }
  return released;
}

/** Retries per row and printing after a failed lookup or save; then the row waits for a reload. */
export const PRICE_RETRY_MAX = 4;

/**
 * A failed price lookup or save is not "no data": the row is asked again
 * after a backoff (2 s, 4 s, 8 s, 16 s) instead of staying unpriced.
 * `failures` counts attempts per `${rowId}:${signature}`; returns the rows
 * still worth retrying and the delay to wait before the next run.
 */
export function nextPriceRetry(failures, rows, signatureOf) {
  const retry = [];
  let delay = 0;
  for (const row of rows) {
    const key = priceKey(row.id, signatureOf(row));
    const used = failures.get(key) || 0;
    if (used >= PRICE_RETRY_MAX) continue;
    failures.set(key, used + 1);
    retry.push(row);
    delay = Math.max(delay, 2000 * 2 ** used);
  }
  return { retry, delay };
}
