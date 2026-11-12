import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { fetchBuyBook } from '@market/buy-orders.js';
import { previewBook, previewScale } from '../pages/buysell-preview-fixture.js';
import { allowMypokoinPreview } from '../pages/mypokoin-preview-fixture.js';
import { whenIdle } from './idle.js';

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
  const [book, setBook] = createSignal(null);
  const [mine, setMine] = createSignal([]);
  const [sellPick, setSellPick] = createSignal('');
  const [offerAsk, setOfferAsk] = createSignal(0);

  let seq = 0;
  function load(id) {
    const run = seq + 1;
    seq = run;
    if (preview) {
      setBook(() => previewBook(untrack(language), scale).book);
      return Promise.resolve();
    }
    return fetchBuyBook(id).then(
      (data) => {
        if (run === seq) setBook(() => (Array.isArray(data?.book) ? data.book : []));
      },
      () => {
        // A failed first read still leaves the desk silent about nothing: the
        // empty book paints the bar's Make offer and the cell's one line. A
        // failed reload keeps the rows already on screen.
        if (run === seq) setBook((current) => (current === null ? [] : current));
      },
    );
  }

  createEffect(
    () => ((preview || ready()) && cardId ? String(cardId) : ''),
    (id) => {
      if (!id) return undefined;
      setBook(null);
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
    noteMine(id) {
      if (id) setMine([...mine(), id]);
    },
    forgetMine(id) {
      setMine(mine().filter((value) => value !== id));
    },
    /** The book rows name the condition they want to sell into; the bar owns the form. */
    pickSell(condition) {
      setSellPick(condition || '');
    },
    sellPick,
    /** A cell that wants the Define offer popup without naming a condition (the empty Buy offers row). */
    askOffer() {
      setOfferAsk(offerAsk() + 1);
    },
    offerAsk,
  };
}
