import { For, Show, createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { DEAL_BOOK_METRICS, buyOfferSellable, dealBookMeasured, dealBookPlan } from '@market/deal-book.js';
import { conditionChipSrc, conditionLabel } from '@market/listing-meta.js';
import { buyerParts } from '../../stores/buyer.js';
import BuySellIcon from '../buysell/BuySellIcon.jsx';
import { Ico } from '../desk/ShopHeader.jsx';
import ShopListingRow from '../desk/ShopListing.jsx';

/**
 * The Best Deal book: who else sells the facet the chips picked, and who is
 * bidding for it. It sits between the chips and the offer bar and only ever
 * fills the height the stretched panel leaves free — the slack is measured with
 * the book itself collapsed, so it is what the desk's other columns give and not
 * a height these lists gave themselves, and the same number caps the region:
 * whole rows only, never a cut-off row, and never a Best Deal column taller than
 * the card in the middle. Below that width the panel stacks, nothing is measured
 * and the caps decide.
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

  /**
   * Spare height in front of these lists. Neither box can simply be asked how
   * tall it is: the desk stretches every column to the row, and the row is as
   * tall as the lists made it, so reading the panel or the region would hand the
   * book its own growth back on every pass. Hence: the panel's fixed parts are
   * summed from its own children with the book held at nothing, the row line is
   * the tallest column beside it measured in that same instant, and the lists may
   * take the difference. A panel that is already the tallest gets 0 and renders
   * nothing, so the desk looks exactly as it did before the book.
   */
  function slack() {
    const panel = region.parentElement;
    const cell = panel?.parentElement;
    const desk = region.closest('.card-desk');
    if (!panel || !cell || !desk) return 0;
    const style = window.getComputedStyle(panel);
    const px = (value) => (Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : 0);
    // Hidden, not squashed: with the book out of the layout the panel has no free
    // height left over, so the auto margin that pins Add to cart to the bottom
    // reads 0. Squashed to 0px it stays a flex item, Chrome reports its USED auto
    // margin, and the panel would look as tall as the void the cap just created.
    const shown = region.style.display;
    region.style.display = 'none';
    const parts = [...panel.children].filter((el) => el !== region);
    let own = px(style.paddingTop) + px(style.paddingBottom) + Math.max(0, parts.length) * px(style.rowGap);
    for (const el of parts) {
      own += el.getBoundingClientRect().height;
    }
    const top = cell.getBoundingClientRect().top;
    let line = own;
    for (const other of desk.children) {
      if (other === cell) continue;
      const box = other.getBoundingClientRect();
      if (Math.abs(box.top - top) > 2) continue; // a lower row of the desk (Shop, Vault)
      line = Math.max(line, box.height);
    }
    region.style.display = shown;
    return Math.max(0, Math.round(line - own));
  }

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
    const space = dealBookMeasured(window.innerWidth) ? slack() : 0;
    // The cap is what makes the rule hold: a scrolled box shrinks to its own box
    // but still counts its content toward the panel's auto height, so without it
    // these lists stretch the Best Deal column past the card in the middle.
    const cap = space ? `${space}px` : '';
    if (region.style.maxHeight !== cap) region.style.maxHeight = cap;
    // With no free height at all the region would still be a flex child, so the
    // panel would pay one more row-gap than the same desk without the book: an
    // empty book leaves the layout instead. Under the stacking width this must not
    // happen, because there the caps decide the rows and nothing is measured.
    const hide = !space && dealBookMeasured(window.innerWidth);
    if ((region.style.display === 'none') !== hide) region.style.display = hide ? 'none' : '';
    // Rows are then counted out of the height the layout really granted, which the
    // cap bounds: the slack is the ceiling, and a shorter panel gets fewer rows.
    const given = space ? Math.min(space, region.clientHeight) : 0;
    if (given !== untrack(available)) setAvailable(given);
  }

  // Solid 2 has no onMount: the compute reads nothing reactive, so this setup
  // runs once after the first render and its cleanup on disposal. The columns
  // BESIDE the panel are what the slack is measured against, so they are observed
  // directly: a capped region does not resize when its content grows, and the desk
  // coalesces a row line that changes while its own callback is being delivered.
  createEffect(
    () => region,
    () => {
      measure();
      const seen = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      const desk = region.closest('.card-desk');
      const cell = region.parentElement?.parentElement;
      if (seen && desk) {
        seen.observe(region);
        for (const other of desk.children) if (other !== cell) seen.observe(other);
      }
      window.addEventListener('resize', measure, { passive: true });
      return () => {
        window.removeEventListener('resize', measure);
        seen?.disconnect();
      };
    },
  );

  // The listings and the book arrive after the first paint and make those columns
  // taller; nothing in the desk's geometry need change for the row line to move,
  // so new data re-reads the slack itself.
  createEffect(
    () => [props.rows, props.deal, props.card, props.language, props.condition, props.buy.book()],
    () => measure(),
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
