import { For, Show, createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { DEAL_BOOK_METRICS, buyOfferSellable, dealBookPlan } from '@market/deal-book.js';
import { conditionChipSrc, conditionLabel } from '@market/listing-meta.js';
import { buyerParts } from '../../stores/buyer.js';
import BuySellIcon from '../buysell/BuySellIcon.jsx';
import { Ico } from '../desk/ShopHeader.jsx';
import ShopListingRow from '../desk/ShopListing.jsx';

/**
 * The Best Deal book: who else sells the facet the chips picked, and who is
 * bidding for it. It sits between the chips and the offer bar and only ever
 * fills the height the stretched panel leaves free — the region is the flex
 * child that shrinks (styles.css, from 1101px), so its measured height says how
 * many whole rows of each list fit and the lists can never grow the column.
 * Below that width the panel stacks, nothing is measured and the caps decide.
 *
 * The seller rows are real Shop rows (`compact`), so price, quantity, the cart
 * button and the own-listing actions stay the Shop's. The offers come from the
 * one buy-order book the desk shares with the offer bar (`props.buy`); their
 * Sell button asks that bar to open its Define offer popup on the row's
 * condition, where the existing Sell now form lives — nothing expands in here.
 *
 * props: buy, rows, deal, condition, language, card, pinned, mineIds,
 * listingBusy, onCart(offer, qty), onInspect(event), onCondition(row),
 * onEdit(offer), onCancel(offer), onSeeAll(total).
 */
export default function DealBook(props) {
  let region;
  const [available, setAvailable] = createSignal(0);
  const [metrics, setMetrics] = createSignal(DEAL_BOOK_METRICS);
  const [width, setWidth] = createSignal(window.innerWidth);

  // styles.css owns the row heights (--deal-book-*) and this reads them back, so
  // the fit test can never disagree with the layout.
  function measure() {
    if (!region) return;
    setWidth(window.innerWidth);
    const style = window.getComputedStyle(region);
    const px = (name, fallback) => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const next = {
      row: px('--deal-book-row', DEAL_BOOK_METRICS.row),
      gap: px('--deal-book-gap', DEAL_BOOK_METRICS.gap),
      head: px('--deal-book-head', DEAL_BOOK_METRICS.head),
      more: px('--deal-book-more', DEAL_BOOK_METRICS.more),
      block: px('--deal-book-block', DEAL_BOOK_METRICS.block),
    };
    // Reads inside an effect callback are not a tracking scope: this runs from
    // the observer and the resize listener too, so it compares outside reactivity.
    const cur = untrack(metrics);
    if (Object.keys(next).some((key) => next[key] !== cur[key])) setMetrics(next);
    const space = untrack(available);
    if (region.clientHeight !== space) setAvailable(region.clientHeight);
  }

  // Solid 2 has no onMount: the compute reads nothing reactive, so this setup
  // runs once after the first render and its cleanup on disposal.
  createEffect(
    () => region,
    () => {
      measure();
      const seen = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      if (region && seen) seen.observe(region);
      window.addEventListener('resize', measure, { passive: true });
      return () => {
        window.removeEventListener('resize', measure);
        seen?.disconnect();
      };
    },
  );

  const plan = createMemo(() => dealBookPlan({
    width: width(),
    available: available(),
    rows: props.rows || [],
    deal: props.deal,
    book: props.buy.book() || [],
    language: props.language,
    condition: props.condition,
    card: props.card,
    metrics: metrics(),
  }));
  const sellers = () => plan().sellers;
  const offers = () => plan().offers;
  const isCurrent = (condition) => condition === props.condition;
  const wantPrice = (row) => {
    const parts = buyerParts(row.best_price_pkn, true, props.pinned);
    return parts.local || parts.pkn || '';
  };

  return (
    <div class="deal-book" ref={(el) => { region = el; }}>
      <Show when={sellers().length}>
        <section class="deal-book-list is-sellers" aria-label="Other sellers">
          <h3 class="shop-label deal-book-head"><Ico name="seller" size="14" />Other sellers</h3>
          <div class="deal-book-rows">
            <For each={sellers()}>
              {(offer) => (
                <ShopListingRow
                  offer={offer}
                  card={props.card}
                  compact
                  showCard={false}
                  mine={props.mineIds.includes(offer.id)}
                  listingBusy={props.listingBusy}
                  onCart={(qty) => props.onCart(offer, qty)}
                  onInspect={props.onInspect}
                  onEdit={() => props.onEdit?.(offer)}
                  onCancel={() => props.onCancel?.(offer)}
                />
              )}
            </For>
          </div>
          <Show when={plan().more}>
            {(total) => (
              <button
                type="button"
                class="linkish deal-book-more"
                onClick={() => props.onSeeAll?.(total())}
              >
                {`See all ${total()} listings`}
              </button>
            )}
          </Show>
        </section>
      </Show>
      <Show when={offers().length}>
        <section class="deal-book-list is-offers" aria-label="Buy offers">
          <h3 class="shop-label deal-book-head"><BuySellIcon size="14" />Buy offers</h3>
          <div class="deal-book-rows">
            <For each={offers()}>
              {(row) => (
                <div class={['deal-offer', { 'is-current': isCurrent(row.condition) }]}>
                  <button
                    type="button"
                    class="deal-offer-cond"
                    title={isCurrent(row.condition)
                      ? `Best Deal shows ${conditionLabel(row.condition)} listings`
                      : `Show ${conditionLabel(row.condition)} listings`}
                    aria-label={`Show ${conditionLabel(row.condition)} listings`}
                    aria-current={isCurrent(row.condition) ? 'true' : undefined}
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
        </section>
      </Show>
    </div>
  );
}
