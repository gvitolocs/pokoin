import { For, Show } from 'solid-js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { lineKeyOf, lineLocation, lineQuantity } from '@market/zero-pick.js';
import { FacetBadges, IssueBadge, linePrice, LocationText, lineWhere, PtPlace, TakeBits } from './zero-bits.jsx';

/**
 * Compact picking table: every line in order under its game header.
 * Also the print layout (forced by @media print even in the Cards view).
 */
export default function ZeroList(props) {
  return (
    <div class={['zero-list', { 'is-print-only': props.printOnly }]} aria-hidden={props.printOnly ? 'true' : undefined}>
      <div class="zero-list-head" aria-hidden="true">
        <span class="zero-print-box-col" />
        <span>Location</span>
        <span>Card</span>
        <span>Set</span>
        <span>Rarity</span>
        <span>Details</span>
        <span>Price</span>
        <span>Picked</span>
        <span class="zero-list-actions-col" />
      </div>
      <For each={props.groups}>
        {(group) => (
          <section class="zero-list-group">
            <h3 class="zero-game-head">
              {group.label}
              <span>{group.cards} card{group.cards === 1 ? '' : 's'}</span>
            </h3>
            <ol class="zero-list-rows">
              <For each={group.lines}>
                {(entry) => {
                  const line = () => entry.line;
                  const key = () => lineKeyOf(line());
                  const pick = () => props.pickOf(line());
                  const quantity = () => lineQuantity(line());
                  return (
                    <li
                      class={['zero-row', {
                        'is-picked': props.isDone(line()),
                        'has-issue': Boolean(pick().issue),
                        'is-match': props.matches?.has(key()),
                        'is-current': props.current === key(),
                      }]}
                      data-zero-line={props.printOnly ? undefined : key()}
                    >
                      <span class="zero-print-box" aria-hidden="true" />
                      <span class="zero-row-loc">
                        <span class="zero-row-place">{props.places.get(key())}</span>
                        <strong class={{ 'is-empty': !lineLocation(line()) }}><LocationText item={line()} /></strong>
                        <TakeBits item={line()} />
                      </span>
                      <span class="zero-row-name">
                        <Show when={line().cardId} fallback={<strong>{line().name}</strong>}>
                          <a href={inventoryListingHref(line())}><strong>{line().name}</strong></a>
                        </Show>
                        <Show when={line().nameEn}><small>{line().nameEn}</small></Show>
                        <Show when={!props.printOnly && props.errors?.[key()]}>
                          <span class="zero-save-error" role="alert">{props.errors[key()]}</span>
                        </Show>
                      </span>
                      <span class="zero-row-set thread-meta">{lineWhere(line())}</span>
                      <span class="zero-row-rarity thread-meta">{line().rarity || ''}</span>
                      <span class="zero-row-facets">
                        <FacetBadges item={line()} />
                        <PtPlace item={line()} />
                        <IssueBadge issue={pick().issue} />
                      </span>
                      <span class="zero-row-price">{linePrice(line())}</span>
                      <span class="zero-row-picked">{pick().picked}/{quantity()}</span>
                      <Show when={!props.printOnly}>
                        <span class="zero-row-actions">
                          <button
                            class={['btn', 'ghost', 'zero-pick-btn', { on: props.isDone(line()) }]}
                            type="button"
                            aria-pressed={pick().picked >= quantity() ? 'true' : 'false'}
                            onClick={() => props.onPick(line())}
                          >
                            {quantity() > 1 ? `Pick ${pick().picked}/${quantity()}` : pick().picked ? 'Undo' : 'Pick'}
                          </button>
                          <Show
                            when={pick().issue}
                            fallback={<button class="btn ghost" type="button" onClick={() => props.onIssue(line())}>Report issue</button>}
                          >
                            <button class="btn ghost" type="button" onClick={() => props.onClearIssue(line())}>Clear issue</button>
                          </Show>
                        </span>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ol>
          </section>
        )}
      </For>
    </div>
  );
}
