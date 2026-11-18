import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import {
  HOUSE_OFFER_PKN,
  MAX_BUY_ORDER_QUANTITY,
  cancelBuyOrder,
  fetchBuyBook,
  fetchMyBuyOrders,
  readBookCache,
  writeBookCache,
} from '@market/buy-orders.js';
import { getBearer, signedIn } from '../stores/auth.js';
import { previewBook, previewScale } from '../pages/buysell-preview-fixture.js';
import { allowMypokoinPreview } from '../pages/mypokoin-preview.js';
import { whenIdle } from './idle.js';

/**
 * The exact target a Sell press sells into, so Quick Sell is complete at the
 * click and never waits for a chip update that has not landed. `row` is a book
 * row (or a board item, which names its order `id` and its copies `remaining`):
 * a book row is an aggregate whose `quantity` sums several orders, so the copies
 * limit is `best_remaining` of the specific best order, never that total.
 * Pokoin's starting offer (`house`) names no order: it takes the facets the
 * caller shows, and every card may be sold into it.
 */
export function sellTarget(row, facets = {}) {
  if (!row) return null;
  const house = Boolean(row.house);
  const orderId = String(row.best_order_id || row.id || '');
  if (!house && !orderId) return null;
  return {
    house,
    orderId: house ? '' : orderId,
    remaining: house
      ? MAX_BUY_ORDER_QUANTITY
      : Math.max(1, Number(row.best_remaining ?? row.remaining) || 1),
    pricePkn: house ? HOUSE_OFFER_PKN : Number(row.best_price_pkn ?? row.price_pkn) || 0,
    condition: (house ? facets.condition : row.condition) || 'NM',
    language: String((house ? facets.language : row.language) || 'EN').toUpperCase(),
    reverse: Boolean(house ? facets.reverse : row.reverse),
    firstEdition: Boolean(house ? facets.firstEdition : (row.first_edition ?? row.firstEdition)),
  };
}

/** What this device last saw for `cardId`, or null when it has never seen it. */
function storedBook(cardId, preview) {
  return preview || !cardId ? null : readBookCache(String(cardId));
}

/**
 * The card's buy-order book, loaded once for the desk: the offer bar and the
 * Best Deal book rows read the same signal, so the panel never asks twice.
 *
 * `book` is what to draw and is never nothing: a card nobody has offered for and
 * a card whose book this device has not seen both draw Pokoin's own starting
 * offer, which comes from `HOUSE_OFFER_PKN` and so needs no answer to say. The
 * book is asked for at idle with a short cap, like everything else behind the
 * first paint, and it no longer waits for the listings to land: nothing about a
 * buyer's offer depends on them. `known` is the separate question — has this
 * device seen the book at all — and is the only thing that may hold a skeleton.
 *
 * A request that never answers leaves an empty book and nothing else; one that
 * answers leaves its rows.
 * `?mypokoinPreview` paints the fixture rows instead, `?mypokoinPreview=100` a
 * hundred offers of them.
 *
 * Orders the visitor posts from this page are remembered, because the book
 * never names a buyer and their own offer must not come back as Sell now.
 */
export function createBuyBook({ cardId, language } = {}) {
  const [params] = useSearchParams();
  const preview = untrack(() => allowMypokoinPreview(params));
  const scale = untrack(() => previewScale(params));
  // A book this device saw for the card paints at once (a reload, a second
  // visit); the request below still runs and replaces it.
  const first = storedBook(cardId, preview);
  const [book, setBook] = createSignal(first || []);
  const [known, setKnown] = createSignal(first !== null);
  const [mine, setMine] = createSignal([]);
  // The same orders with their own price and copies, so the offer bar can edit
  // one instead of guessing from the aggregate row of the public book.
  const [mineRows, setMineRows] = createSignal([]);
  const [sellPick, setSellPick] = createSignal(null);
  const [offerAsk, setOfferAsk] = createSignal(0);
  // A new intent is always its own object, and `seq` counts them: pressing Sell
  // on the same row twice opens the dialog again rather than being a no-op.
  let sellSeq = 0;

  let seq = 0;
  function load(id, { fresh = false } = {}) {
    const run = seq + 1;
    seq = run;
    if (preview) {
      setBook(() => previewBook(untrack(language), scale).book);
      setKnown(true);
      return Promise.resolve();
    }
    loadMine(id, run);
    return fetchBuyBook(id, { fresh }).then(
      (data) => {
        if (run !== seq) return;
        const rows = Array.isArray(data?.book) ? data.book : [];
        // An answer that changed nothing is the book already on screen: re-setting
        // the signal would rebuild every row of the cell for nothing (rule 3).
        setBook((current) => (JSON.stringify(current) === JSON.stringify(rows) ? current : rows));
        setKnown(true);
        writeBookCache(id, rows);
      },
      () => {
        // A book that never answers stays the empty one it started as: the bar
        // offers Make offer and the cell names Pokoin's own line rather than
        // holding a skeleton forever. Rows a previous answer put on screen stay.
        if (run === seq) setKnown(true);
      },
    );
  }

  /**
   * A signed-in visitor's own open offers on this card, so an offer they posted
   * on an earlier visit is still theirs after a reload: it shows Cancel, not
   * Sell, and the bar can edit it with its own price and copies. Best effort; a
   * failure keeps what this page already remembers.
   */
  async function loadMine(id, run) {
    if (!signedIn()) return;
    try {
      const token = await getBearer();
      if (!token) return;
      const data = await fetchMyBuyOrders(token);
      if (run !== seq) return;
      const rows = (Array.isArray(data?.items) ? data.items : [])
        .filter((row) => String(row?.card_id) === String(id) && row?.state === 'open' && row?.id);
      setMineRows((current) => {
        const byId = new Map(current.map((row) => [String(row.id), row]));
        for (const row of rows) byId.set(String(row.id), row);
        return [...byId.values()];
      });
      setMine([...new Set([...untrack(mine), ...rows.map((row) => row.id)])]);
    } catch (_) { /* the book still paints; only the Cancel button is missing */ }
  }

  /**
   * Take one order out of the rows on screen the moment the delete answers. A
   * facet row whose only order was this one has nothing left to show; one that
   * still holds other buyers stays until the fresh load says what is left of it.
   */
  function dropOrderRow(id) {
    const rows = untrack(book);
    if (!Array.isArray(rows)) return;
    const kept = rows.filter((row) => !(row
      && String(row.best_order_id) === String(id)
      && (Number(row.orders) || 0) === 1));
    if (kept.length === rows.length) return;
    setBook(() => kept);
    writeBookCache(String(cardId), kept);
  }

  /**
   * Cancels one of the visitor's offers and repaints the book. Throws what the
   * API answers. The reload is `fresh`: the edge would otherwise hand back the
   * book as it was up to 15 s before the delete, and the offer would reappear.
   */
  async function cancel(id) {
    const token = await getBearer();
    if (!token) throw Object.assign(new Error('unauthorized'), { status: 401 });
    await cancelBuyOrder(id, token);
    setMine(untrack(mine).filter((value) => value !== id));
    setMineRows(untrack(mineRows).filter((row) => String(row?.id) !== String(id)));
    dropOrderRow(id);
    await load(String(cardId), { fresh: true });
  }

  createEffect(
    () => (cardId ? String(cardId) : ''),
    (id) => {
      if (!id) return undefined;
      const seed = storedBook(id, preview);
      setBook(seed || []);
      setKnown(seed !== null);
      // 300 ms, not the 4 s default: this is the desk's own sell side, and an
      // offer bar that waits four seconds for idle waits for nothing.
      return whenIdle(() => { load(id); }, 300);
    },
  );
  onCleanup(() => { seq += 1; });

  return {
    preview,
    book,
    /** Has this device seen this card's book, as an answer or as a stored copy? */
    known,
    mine,
    /** The visitor's own open order `id` on this card, or null when unseen yet. */
    order: (id) => untrack(mineRows).find((row) => String(row?.id) === String(id || '')) || null,
    id: () => (cardId ? String(cardId) : ''),
    /**
     * Read the book again. `{ fresh: true }` bypasses the edge cache, which every
     * reload after one of the visitor's own writes must do; the plain page-load
     * read stays cacheable.
     */
    reload: (options) => load(String(cardId), options),
    cancel,
    noteMine(id, row) {
      if (!id) return;
      setMine([...mine(), id]);
      if (row && String(row.id) === String(id)) {
        setMineRows([...mineRows().filter((other) => String(other?.id) !== String(id)), row]);
      }
    },
    forgetMine(id) {
      setMine(mine().filter((value) => value !== id));
      setMineRows(mineRows().filter((row) => String(row?.id) !== String(id)));
    },
    /**
     * Ask the desk to open Quick Sell on an exact target (`sellTarget(row)`).
     * The rows own the facets they were aggregated from, so a press carries the
     * whole offer: the dialog never reads a chip that may not have landed yet.
     */
    pickSell(target) {
      if (!target) {
        setSellPick(null);
        return;
      }
      sellSeq += 1;
      setSellPick({ ...target, seq: sellSeq });
    },
    sellPick,
    /** Quick Sell closed: the intent is spent, and the next press is a fresh dialog. */
    closeSell() {
      setSellPick(null);
    },
    /** A cell that wants the Define offer popup without naming a condition (the empty Buy offers row). */
    askOffer() {
      setOfferAsk(offerAsk() + 1);
    },
    offerAsk,
  };
}
