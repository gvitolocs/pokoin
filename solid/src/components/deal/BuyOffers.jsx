import { createSignal, For, Show } from 'solid-js';
import { buyOfferSellable, buyOfferTotal, dealBookCount, deskOfferRows, seeAllOffers } from '@market/deal-book.js';
import { conditionChipSrc, conditionLabel } from '@market/listing-meta.js';
import { flagSrc } from '@market/locale.js';
import { errorMessage, HOUSE_OFFER_PKN, offerPriceLabel } from '@market/buy-orders.js';
import { sellTarget } from '../../lib/buy-book.js';
import { buyerCurrency } from '../../stores/buyer.js';
import AppLink from '../AppLink.jsx';
import BuySellIcon from '../buysell/BuySellIcon.jsx';

/**
 * Who is buying this card: the best order per condition for the language the
 * chips picked, strongest bid first, up to `max` (three on desktop, two on a
 * phone). The rows come from the one buy-order book the desk shares with the
 * offer bar (`props.buy`), so the panel never asks twice.
 *
 * A row's condition chip moves the desk to that facet; its Sell button hands the
 * row's own offer — order id, price, remaining copies and facets — to Quick Sell.
 * With no orders the cell still says so and offers Pokoin's starting offer, so
 * the desk never shows a blank box. Selling never opens the Define offer popup,
 * which is the buyer's side of the trade.
 *
 * The count is the card's, not the facet's — every offer behind the cap, in
 * every grade and language — because `See all N offers` leaves the desk for the
 * BuySell board, which lists them all.
 *
 * props: buy, language, condition, pinned, max, onCondition(row).
 */
export default function BuyOffers(props) {
  const book = () => props.buy.book();
  const rows = () => (Array.isArray(book()) ? deskOfferRows(book(), { language: props.language, max: props.max }) : []);
  const sameLang = (row) => String(row.language || '').toUpperCase() === String(props.language || '').toUpperCase();
  const isMine = (row) => Boolean(row.best_order_id) && props.buy.mine().includes(row.best_order_id);
  const total = () => buyOfferTotal(book());
  const hidden = () => seeAllOffers(book(), rows());
  // The same label the offer bar uses, so a sub-cent offer reads the same in both places.
  const wantPrice = (row) => offerPriceLabel(row.best_price_pkn, buyerCurrency(props.pinned) || 'PKN');
  const [cancelling, setCancelling] = createSignal('');
  const [cancelError, setCancelError] = createSignal('');
  async function cancelOffer(id) {
    if (cancelling()) return;
    setCancelling(id);
    setCancelError('');
    try {
      await props.buy.cancel(id);
    } catch (err) {
      setCancelError(errorMessage(err));
    } finally {
      setCancelling('');
    }
  }
  return (
    <Show
      when={Array.isArray(book())}
      fallback={(
        // Until the book is known the cell is already there, at its final size,
        // with three placeholder rows: the desk does not move when it answers.
        <section class="panel desk-cell cell-offers is-loading" aria-label="Buy offers" aria-busy="true">
          <h2 class="cell-title">
            <span class="shop-label"><BuySellIcon size="14" />Buy offers</span>
          </h2>
          <div class="cell-rows cell-skel" aria-hidden="true"><span /><span /><span /></div>
        </section>
      )}
    >
      <section class="panel desk-cell cell-offers" aria-label="Buy offers">
        <h2 class="cell-title">
          <span class="shop-label"><BuySellIcon size="14" />Buy offers</span>
          <span class="cell-count">{dealBookCount(rows().length, total())}</span>
          <Show when={hidden()}>
            <AppLink class="linkish cell-more" to="/cardgts" aria-label={`See all ${hidden()} offers`}>
              See all
            </AppLink>
          </Show>
        </h2>
        <Show
          when={rows().length}
          fallback={(
            <p class="cell-empty">
              {/* Never an empty cell: with no buyer's offer, Pokoin's starting offer is the one to sell into. */}
              {`Pokoin buys it for ${offerPriceLabel(HOUSE_OFFER_PKN, buyerCurrency(props.pinned) || 'PKN')}.`}{' '}
              <button type="button" class="linkish" onClick={() => props.buy.pickSell(sellTarget({ house: true }, { condition: props.condition, language: props.language }))}>
                Sell
              </button>
              {' · '}
              <button type="button" class="linkish" onClick={() => props.buy.askOffer()}>
                Make offer
              </button>
            </p>
          )}
        >
          <div class="cell-rows">
            <For each={rows()}>
              {(row) => (
                <div class={['deal-offer', { 'is-current': row.condition === props.condition && sameLang(row), 'is-mine': isMine(row) }]}>
                  <button
                    type="button"
                    class="deal-offer-cond"
                    title={row.condition === props.condition
                      ? `Best Deal shows ${conditionLabel(row.condition)} listings`
                      : `Show ${conditionLabel(row.condition)} listings`}
                    aria-label={`Show ${conditionLabel(row.condition)} listings`}
                    aria-current={row.condition === props.condition ? 'true' : undefined}
                    onClick={() => props.onCondition?.(row)}
                  >
                    <img class="shop-cond" src={conditionChipSrc(row.condition)} alt="" width="40" height="28" draggable="false" />
                  </button>
                  {/* An offer in another language than the chips' says which. */}
                  <Show when={!sameLang(row)}>
                    <span class="deal-offer-lang" title={row.language}>
                      <img class="deal-flag" src={flagSrc(row.language)} alt="" width="18" height="18" />
                      {row.language}
                    </span>
                  </Show>
                  <span class="deal-offer-want">{isMine(row) ? `Your offer · ${row.quantity} wanted` : `${row.quantity} ${conditionLabel(row.condition).toLowerCase()} wanted`}</span>
                  <span class="deal-offer-px">{wantPrice(row)}</span>
                  <Show when={buyOfferSellable(row, props.buy.mine())}>
                    <button
                      type="button"
                      class="deal-offer-sell"
                      title={`Sell into the ${conditionLabel(row.condition)} offer`}
                      aria-label={`Sell into the ${conditionLabel(row.condition)} offer`}
                      onClick={() => props.buy.pickSell(sellTarget(row))}
                    >
                      Sell
                    </button>
                  </Show>
                  {/* The visitor's own offer is the row's best one: a red cross takes it back right here. */}
                  <Show when={isMine(row)}>
                    <button
                      type="button"
                      class="deal-offer-cancel"
                      title="Delete your offer"
                      aria-label={`Delete your ${conditionLabel(row.condition)} ${row.language} offer`}
                      disabled={cancelling() === row.best_order_id}
                      onClick={() => cancelOffer(row.best_order_id)}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={cancelError()}><p class="sell-msg error">{cancelError()}</p></Show>
      </section>
    </Show>
  );
}
