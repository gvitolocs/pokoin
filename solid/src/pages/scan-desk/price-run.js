/**
 * The Scan desk pricing run: one row at a time, never one run at a time.
 *
 * A row's price comes from sold comps, else the cheapest listed price, else the
 * documented fallback, so no active row reaches the upload without one. Each row
 * is claimed on its own (`scan-desk/price-requests.js`) and is asked for one
 * printing shape, so a new scan, another row's save or a batch change never
 * cancels a lookup that is already in flight.
 *
 * A suggestion is written only after the live row has been re-read: a row that
 * changed printing or facets, stopped being active, or got a manual price in the
 * meantime is not overwritten, and its claim is dropped rather than left behind.
 *
 * The desk hands this module the primitives it owns (`loadSlices`,
 * `loadCheapest`, `save`, `retry`) and the row store; everything else — what to
 * ask for, when a row is stale, which rung of the price chain applies — lives
 * here and is tested without a browser.
 */

// Relative, not @market: node --test loads this module without Vite's alias.
import {
  facetSignature,
  priceFieldCommit,
  scanFacets,
  scanFallbackPricePkn,
  suggestPriceFromSlices,
} from '../../../../market/src/scan-pricing.js';
import { claimRows, dropRows, isAskable, markSettled } from './price-requests.js';

/** Rows one run works on, and sold-comps reads it keeps in flight. */
export const PRICE_RUN_LIMIT = 12;
export const SLICES_CONCURRENCY = 4;

/**
 * Whether this row is the price pipeline's business right now.
 *
 * A seller who clicked into the price box owns that *shape*'s price: a new
 * printing, condition or language is new intent and is priced again. A row that
 * already has a suggestion for another shape is re-priced, a manual price of its
 * own is never touched, and a row inside its give-up cool-down waits.
 */
export function rowNeedsPrice(row, { books, touched, signatureOf = facetSignature }) {
  if (!row.cardId) return false;
  const signature = signatureOf(row);
  if (touched.get(row.id) === signature) return false;
  if (!isAskable(row, books)) return false;
  if (row.pricePkn == null) return true;
  return row.priceSuggested === true && books.suggestedFor.get(row.id) !== signature;
}

/** The rows this run claims, in queue order, at most `limit`. */
export function selectPriceRows(rows, {
  books,
  touched,
  signatureOf = facetSignature,
  limit = PRICE_RUN_LIMIT,
} = {}) {
  const want = [];
  for (const row of rows) {
    if (!rowNeedsPrice(row, { books, touched, signatureOf })) continue;
    want.push(row);
    if (want.length >= limit) break;
  }
  return want;
}

/**
 * Is the live row still the row this suggestion was computed for? A row that
 * changed printing or facets, stopped being active or vanished is stale, and its
 * price must never be written onto it: that is how one printing's price landed
 * on another and silenced the "Needs a price" blocker. Qty is not a facet.
 */
export function staleSuggestion(claimed, live, signatureOf = facetSignature) {
  if (!live || live.id !== claimed.id) return true;
  if (live.status !== 'active') return true;
  return signatureOf(claimed) !== signatureOf(live);
}

/** A row with a price the seller typed themselves is theirs, not the pipeline's. */
export function acceptsSuggestion(live) {
  return live.pricePkn == null || live.priceSuggested === true;
}

/**
 * The patch that stores the default price, decided from the *live* row and never
 * from the claim-time snapshot: an empty price is filled only if it is still
 * empty (`onlyIfEmptyPrice`, kept nested in `patch` for the server), a suggestion
 * for this same shape is replaced.
 */
export function suggestionPatch(live, pkn) {
  const patch = { pricePkn: Math.round(pkn), priceSuggested: true };
  if (live.pricePkn == null) patch.onlyIfEmptyPrice = true;
  return patch;
}

/**
 * What leaving the desk price field means, adding the one thing
 * `priceFieldCommit` cannot see: whether the seller typed in it at all. A field
 * whose text nobody edited is not a new price — the reactive row can repaint
 * it, and a suggestion left alone stays a suggestion (`default`, never `set`).
 * An emptied field always gives the price back to the default, whether it held
 * a manual number or a suggestion.
 */
export function priceFieldBlur(row, raw, currency, dirty) {
  const commit = priceFieldCommit(row, raw, currency);
  if (commit.action !== 'set') return commit;
  const same = Number(commit.pricePkn) === Number(row.pricePkn);
  // A field nobody typed in is not the seller writing a price: never save what
  // they did not write, and keep a suggestion a suggestion.
  if (!dirty) return row.priceSuggested ? { action: 'default' } : { action: same ? 'keep' : 'restore' };
  // Only a *different* number makes the price manual; re-typing the suggestion
  // unchanged is the same price, shown the same way.
  return same && row.priceSuggested ? { action: 'keep' } : commit;
}

/**
 * Price `rows` (already selected by `selectPriceRows`); claims them first.
 * Returns a promise that settles when every row has an outcome, so tests can
 * await a whole run.
 *
 * `deps`: `books`, `liveRow(id)`, `loadSlices(cardId)` → `{ ok, slices }` and
 * `loadCheapest(ids)` → `{ [cardId]: pkn }` (both cached by the caller; a
 * printing missing from the cheapest answer is "no listing", which is also what
 * a failed read must produce), `save(row, patch)` (truthy only once the server
 * took it), `retry(rows)`, `rememberDefault(rowId, signature, pkn)`.
 */
export function startPriceRun(rows, deps) {
  if (!rows.length) return Promise.resolve();
  const signatureOf = deps.signatureOf || facetSignature;
  const facetsOf = deps.facetsOf || scanFacets;
  const decided = new Set();

  /** The row has its price, or is asked again after a backoff. */
  const settle = (row, ok) => {
    if (decided.has(row.id)) return;
    decided.add(row.id);
    if (!markSettled(deps.books, row, ok)) deps.retry([row]);
  };
  /** The desk no longer owns this row: release it quietly, no retry, no banner. */
  const drop = (row) => {
    if (decided.has(row.id)) return;
    decided.add(row.id);
    dropRows(deps.books, [row]);
  };

  /** Re-read the row, then store `pkn` as its default price if it is still the row we asked about. */
  const write = (row, pkn) => {
    const signature = signatureOf(row);
    const price = Math.round(pkn);
    const current = deps.liveRow(row.id);
    if (staleSuggestion(row, current, signatureOf)) {
      drop(row);
      return undefined;
    }
    if (!acceptsSuggestion(current)) {
      // A manual price appeared while the lookup ran: it wins, the row is done.
      settle(row, true);
      return undefined;
    }
    if (current.priceSuggested === true && Number(current.pricePkn) === price) {
      // Already the price the server holds: saving it again would only churn.
      deps.rememberDefault?.(row.id, signature, price);
      settle(row, true);
      return undefined;
    }
    const patch = suggestionPatch(current, price);
    return Promise.resolve(deps.save(row, patch)).then((ok) => {
      if (ok === true) deps.rememberDefault?.(row.id, signature, patch.pricePkn);
      // A save that failed on a row the desk no longer owns is not transient.
      if (ok !== true && staleSuggestion(row, deps.liveRow(row.id), signatureOf)) drop(row);
      else settle(row, ok === true);
      return ok === true;
    });
  };

  claimRows(rows, deps.books);
  const claimed = [...rows];

  const run = async () => {
    // Sold comps are read once per printing, four at a time.
    const slices = new Map();
    const todo = [...new Set(claimed.map((row) => String(row.cardId)))];
    await Promise.all(Array.from({ length: Math.min(SLICES_CONCURRENCY, todo.length) }, async () => {
      while (todo.length) {
        const id = todo.shift();
        try {
          slices.set(id, await deps.loadSlices(id));
        } catch (_) {
          slices.set(id, { ok: false, slices: [] });
        }
      }
    }));

    const writes = [];
    const noComps = [];
    for (const row of claimed) {
      if (decided.has(row.id)) continue;
      const entry = slices.get(String(row.cardId));
      if (!entry || entry.ok !== true || !Array.isArray(entry.slices)) {
        // A failed comps read is not "no comps": the row is asked again.
        settle(row, false);
        continue;
      }
      const pkn = suggestPriceFromSlices(entry.slices, facetsOf(row));
      if (pkn > 0) writes.push(write(row, pkn));
      else noComps.push(row);
    }

    if (!noComps.length) return Promise.all(writes);
    // No sold comps: the cheapest listed price, then the €10,000 fallback. One
    // request for the printings that need it, cached per printing by the caller.
    // A printing missing from the answer — nobody lists it, or the query failed
    // — is priced from the fallback, so a transport error never strands the
    // group at "Needs a price" and one dead printing prices only itself.
    let listed = {};
    try {
      listed = (await deps.loadCheapest([...new Set(noComps.map((row) => String(row.cardId)))])) || {};
    } catch (_) {
      listed = {};
    }
    for (const row of noComps) {
      if (decided.has(row.id)) continue;
      const value = Number(listed[String(row.cardId)]);
      writes.push(write(row, value > 0 ? value : scanFallbackPricePkn()));
    }
    return Promise.all(writes);
  };

  return run().catch(() => {
    // Nothing above may leave a row claimed without an outcome.
    for (const row of claimed) if (!decided.has(row.id)) settle(row, false);
  });
}
