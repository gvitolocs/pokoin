import { For, Show } from 'solid-js';
import { cheapestRows, dealBookCount, listingTotal, seeAllListings } from '@market/deal-book.js';
import { Ico } from '../desk/ShopHeader.jsx';
import ShopListingRow from '../desk/ShopListing.jsx';

/**
 * The desk's listing summary: the cheapest Pokoin listings of the card, up to
 * `max` (three on desktop, two on a phone). It is the page's summary and not a
 * readout of the chips, so it walks every condition and language and includes the
 * very listing the price band above shows — the band is one facet, this is the market.
 *
 * The rows are real Shop rows (`compact`), so price, quantity, the cart button
 * and the own-listing actions stay the Shop's. Everything beyond the cap is one
 * click away: `See all N listings` opens the full Shop panel in place below the
 * desk rows, and the same line closes it again. The title names what is drawn
 * and what the card really has (`3 of 100`), so a capped cell never reads as the
 * whole market.
 *
 * props: rows, card, ready, marketPrice, max, open, mineIds, listingBusy,
 * onCart(offer, qty), onInspect(event), onEdit(offer), onCancel(offer), onSeeAll(total).
 */
export default function CheapestListings(props) {
  const rows = () => cheapestRows({ rows: props.rows, max: props.max });
  const total = () => listingTotal({ rows: props.rows });
  const hidden = () => seeAllListings({ rows: props.rows, shown: rows() });
  return (
    <section class="panel desk-cell cell-cheap" aria-label="Cheapest listings">
      <h2 class="cell-title">
        <span class="shop-label"><Ico name="seller" size="14" />Cheapest listings</span>
        <span class="cell-count">{dealBookCount(rows().length, total())}</span>
        <Show when={hidden()}>
          {(count) => (
            <button
              type="button"
              class="linkish cell-more"
              aria-expanded={props.open ? 'true' : 'false'}
              aria-label={props.open ? 'Hide the full shop' : `See all ${count()} listings`}
              onClick={() => props.onSeeAll?.(count())}
            >
              {props.open ? 'Hide' : 'See all'}
            </button>
          )}
        </Show>
      </h2>
      <Show
        when={rows().length}
        fallback={(
          <div class="empty-shop">
            <Show when={props.ready} fallback={<p class="status"> </p>}>
              <p class="status">No listings yet.</p>
            </Show>
          </div>
        )}
      >
        <div class="cell-rows">
          <For each={rows()}>
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
      </Show>
    </section>
  );
}
