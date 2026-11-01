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
