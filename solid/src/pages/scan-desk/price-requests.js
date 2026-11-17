/**
 * Price-suggestion bookkeeping for the Scan Desk prices effect.
 *
 * The books are per row *and per printing shape*, never per run:
 * `pricesAsked` holds the `${rowId}:${signature}` keys a lookup is working on,
 * `suggestedFor` the signature each row was last asked for, `priceFailures` the
 * attempts spent per key and `retryAt` when a key that used its budget may be
 * asked again.
 *
 * A row stops being claimed only when something definite happened to it:
 * `markSettled` after a save that landed, `releaseUnsettled` for a run that is
 * being dropped, `nextPriceRetry` for a failure, `dropRows` for a row that is
 * gone or no longer active. Nothing may leave a key claimed forever: a claimed
 * row is never asked again, which is how a row ended up stuck at
 * "Needs a price" until a reload.
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
    forgetClaim({ pricesAsked, suggestedFor, signatureOf }, row);
    released.push(row);
  }
  return released;
}

/** Forgets that `row` was asked, leaving a newer claim of another signature alone. */
function forgetClaim(books, row) {
  const signature = books.signatureOf(row);
  const key = priceKey(row.id, signature);
  books.pricesAsked.delete(key);
  if (books.suggestedFor.get(row.id) === signature) books.suggestedFor.delete(row.id);
  return key;
}

/**
 * The end of one row's lookup: a row is settled only once its save succeeded.
 * `ok === true` drops the claim (the row has its price) and clears the failure
 * budget; anything else — a rejected save, a save that found no live row, an
 * `undefined` — releases the claim so the row is asked again instead of staying
 * "already asked" with an empty price box.
 */
export function markSettled(books, row, ok) {
  const signature = books.signatureOf(row);
  const key = priceKey(row.id, signature);
  if (ok === true) {
    books.pricesAsked.delete(key);
    books.suggestedFor.set(row.id, signature);
    books.priceFailures.delete(key);
    if (books.retryAt) books.retryAt.delete(key);
    return true;
  }
  forgetClaim(books, row);
  return false;
}

/** A row that is gone, paused or in a closed batch: no lookup and no retry. */
export function dropRows(books, rows) {
  for (const row of rows) {
    const key = forgetClaim(books, row);
    books.priceFailures.delete(key);
    if (books.retryAt) books.retryAt.delete(key);
  }
  return rows;
}

/** Whether `row` may be claimed now: not already asked, and out of its cool-down. */
export function isAskable(row, books) {
  const key = priceKey(row.id, books.signatureOf(row));
  if (books.pricesAsked.has(key)) return false;
  const readyAt = books.retryAt?.get(key) ?? 0;
  return !(readyAt && books.now() < readyAt);
}

/** Attempts per row and printing before the desk stops trying so fast. */
export const PRICE_RETRY_MAX = 4;

/** How long a row that used its budget waits before it is asked again. */
export const PRICE_GIVEUP_DELAY = 60000;

/**
 * A failed price lookup or save is not "no data": the rows still under budget
 * come back in `retry` to be asked again after a backoff (2 s, 4 s, 8 s, 16 s),
 * `delay` says how long to wait.
 *
 * A row that used its budget is *released* and comes back in `gaveUp`: kept in
 * `priceFailures` so the fast budget is not re-spent, and parked in `retryAt`
 * so the next `delay` keeps asking without hammering the endpoint. `terminal`
 * (the row is gone or stopped being active) releases the row, clears its
 * budget and returns no delay: retrying it cannot succeed, and a row that
 * becomes active again is asked from scratch.
 */
export function nextPriceRetry(books, rows, { terminal = false } = {}) {
  const { priceFailures, retryAt, signatureOf } = books;
  const retry = [];
  const gaveUp = [];
  let delay = 0;
  for (const row of rows) {
    const signature = signatureOf(row);
    const key = priceKey(row.id, signature);
    const used = priceFailures.get(key) || 0;
    if (terminal) {
      priceFailures.delete(key);
      retryAt.delete(key);
      forgetClaim(books, row);
      gaveUp.push(row);
      continue;
    }
    if (used >= PRICE_RETRY_MAX) {
      retryAt.set(key, books.now() + PRICE_GIVEUP_DELAY);
      forgetClaim(books, row);
      gaveUp.push(row);
      delay = Math.max(delay, PRICE_GIVEUP_DELAY);
      continue;
    }
    priceFailures.set(key, used + 1);
    retry.push(row);
    delay = Math.max(delay, 2000 * 2 ** used);
  }
  return { retry, gaveUp, delay };
}
