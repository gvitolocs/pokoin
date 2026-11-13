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
import { allowMypokoinPreview } from '../pages/mypokoin-preview-fixture.js';
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

/**
 * The card's buy-order book, loaded once for the desk: the offer bar and the
 * Best Deal book rows read the same signal, so the panel never asks twice. It
 * waits for the listings (`ready`) and defers to idle, like everything else
 * behind the first paint; a request that never answers leaves the book null and
 * nothing is drawn, and one that answers with nothing to show leaves an empty
 * book, so the bar and the rows say so instead of vanishing.
 * `?mypokoinPreview` paints the fixture rows instead, `?mypokoinPreview=100` a
 * hundred offers of them.
 *
 * Orders the visitor posts from this page are remembered, because the book
 * never names a buyer and their own offer must not come back as Sell now.
 */
export function createBuyBook({ cardId, ready, language } = {}) {
  const [params] = useSearchParams();
  const preview = untrack(() => allowMypokoinPreview(params));
  const scale = untrack(() => previewScale(params));
  // A book this device saw for the card paints at once (a reload, a second
  // visit); the request below still runs and replaces it. `loading` is true
  // only while there is nothing at all to show, which the bar and the cell
  // draw as a skeleton of their final size.
  const stored = () => (preview || !cardId ? null : readBookCache(String(cardId)));
  const [book, setBook] = createSignal(stored());
  const [mine, setMine] = createSignal([]);
  const [sellPick, setSellPick] = createSignal(null);
  const [offerAsk, setOfferAsk] = createSignal(0);
  // A new intent is always its own object, and `seq` counts them: pressing Sell
  // on the same row twice opens the dialog again rather than being a no-op.
  let sellSeq = 0;

  let seq = 0;
  function load(id) {
    const run = seq + 1;
    seq = run;
    if (preview) {
      setBook(() => previewBook(untrack(language), scale).book);
      return Promise.resolve();
    }
    loadMine(id, run);
    return fetchBuyBook(id).then(
      (data) => {
        if (run !== seq) return;
        const rows = Array.isArray(data?.book) ? data.book : [];
        setBook(() => rows);
        writeBookCache(id, rows);
      },
      () => {
        // A failed first read still leaves the desk silent about nothing: the
        // empty book paints the bar's Make offer and the cell's one line. A
        // failed reload keeps the rows already on screen.
        if (run === seq) setBook((current) => (current === null ? [] : current));
      },
    );
  }

  /**
   * A signed-in visitor's own open offers on this card, so an offer they posted
   * on an earlier visit is still theirs after a reload: it shows Cancel, not
   * Sell. Best effort; a failure keeps what this page already remembers.
   */
  async function loadMine(id, run) {
    if (!signedIn()) return;
    try {
      const token = await getBearer();
      if (!token) return;
      const data = await fetchMyBuyOrders(token);
      if (run !== seq) return;
      const ids = (Array.isArray(data?.items) ? data.items : [])
        .filter((row) => String(row?.card_id) === String(id) && row?.state === 'open' && row?.id)
        .map((row) => row.id);
      setMine([...new Set([...untrack(mine), ...ids])]);
    } catch (_) { /* the book still paints; only the Cancel button is missing */ }
  }

  /** Cancels one of the visitor's offers and repaints the book. Throws what the API answers. */
  async function cancel(id) {
    const token = await getBearer();
    if (!token) throw Object.assign(new Error('unauthorized'), { status: 401 });
    await cancelBuyOrder(id, token);
    setMine(untrack(mine).filter((value) => value !== id));
    await load(String(cardId));
  }

  createEffect(
    () => ((preview || ready()) && cardId ? String(cardId) : ''),
    (id) => {
      if (!id) return undefined;
      setBook(() => stored());
      return whenIdle(() => { load(id); });
    },
  );
  onCleanup(() => { seq += 1; });

  return {
    preview,
    book,
    mine,
    id: () => (cardId ? String(cardId) : ''),
    reload: () => load(String(cardId)),
    cancel,
    noteMine(id) {
      if (id) setMine([...mine(), id]);
    },
    forgetMine(id) {
      setMine(mine().filter((value) => value !== id));
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
