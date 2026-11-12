import { For, Show } from 'solid-js';
import { buyOfferRows, buyOfferSellable } from '@market/deal-book.js';
import { conditionChipSrc, conditionLabel } from '@market/listing-meta.js';
import { buyerParts } from '../../stores/buyer.js';
import BuySellIcon from '../buysell/BuySellIcon.jsx';

/**
 * Who is buying this card: the best order per condition for the language the
 * chips picked, strongest bid first, up to `max` (three on desktop, two on a
 * phone). The rows come from the one buy-order book the desk shares with the
 * offer bar (`props.buy`), so the panel never asks twice.
 *
 * A row's condition chip moves the desk to that facet; its Sell button asks the
 * offer bar to open its Define offer popup on that condition. With no orders the
 * cell still says so and offers the same popup, so the desk never shows a blank box.
 *
 * props: buy, language, condition, pinned, max, onCondition(row).
 */
export default function BuyOffers(props) {
  const book = () => props.buy.book();
  const rows = () => (Array.isArray(book()) ? buyOfferRows(book(), { language: props.language, max: props.max }) : []);
  const wantPrice = (row) => {
    const parts = buyerParts(row.best_price_pkn, true, props.pinned);
    return parts.local || parts.pkn || '';
  };
  return (
    <Show when={Array.isArray(book())}>
      <section class="panel desk-cell cell-offers" aria-label="Buy offers">
        <h2 class="shop-label cell-title"><BuySellIcon size="14" />Buy offers</h2>
        <Show
          when={rows().length}
          fallback={(
            <p class="cell-empty">
              No buy offers yet.{' '}
              <button type="button" class="linkish" onClick={() => props.buy.askOffer()}>
                Make offer
              </button>
            </p>
          )}
        >
          <div class="cell-rows">
            <For each={rows()}>
              {(row) => (
                <div class={['deal-offer', { 'is-current': row.condition === props.condition }]}>
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
                  <span class="deal-offer-px">{wantPrice(row)}</span>
                  <span class="deal-offer-want">{`${row.quantity} ${conditionLabel(row.condition).toLowerCase()} wanted`}</span>
                  <Show when={buyOfferSellable(row, props.buy.mine())}>
                    <button
                      type="button"
                      class="deal-offer-sell"
                      title={`Sell into the ${conditionLabel(row.condition)} offer`}
                      aria-label={`Sell into the ${conditionLabel(row.condition)} offer`}
                      onClick={() => props.buy.pickSell(row.condition)}
                    >
                      Sell
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}
