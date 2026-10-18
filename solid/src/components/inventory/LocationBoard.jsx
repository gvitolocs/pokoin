import { For, Show } from 'solid-js';
import { groupBoxStacks, inventoryListingHref, listingBox } from '@market/inventory-listings.js';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '@market/listing-meta.js';
import RowThumb from './RowThumb.jsx';

function stackLabel(stack) {
  return stack === 0 ? 'Cards in the box' : `Stack ${stack}`;
}

const paused = (row) => String(row?.status || '').toLowerCase() === 'paused';

/**
 * One box: every listing stored in
 * it, grouped per divider stack, then position, then listed date.
 */
export default function LocationBoard(props) {
  // The URL may carry a full slot string (…/location/megaevoluzionietb·2-4) —
  // the box is the part before the first separator.
  const box = () => listingBox(props.location) || props.location;
  const stacks = () => groupBoxStacks(props.rows, box());
  const dividerCount = () => stacks().filter((stack) => stack.stack > 0).length;
  const postings = () => stacks().reduce((sum, stack) => sum + stack.postingCount, 0);
  const copies = () => stacks().reduce((sum, stack) => sum + stack.copies, 0);

  return (
    <section class="inv-board" aria-label={`Cards in ${box()}`}>
      <div class="mypokoin-panel-head">
        <div>
          <h2>{box()}</h2>
          <p class="mypokoin-help">Listings stored in this box, by stack and position.</p>
        </div>
        <a class="btn" href="/inventory/scan">Scan cards</a>
      </div>
      <div class="inv-summary">
        <Show when={dividerCount() > 0}><div class="inv-stat"><strong>{dividerCount()}</strong><span>Stacks</span></div></Show>
        <div class="inv-stat"><strong>{postings()}</strong><span>Postings</span></div>
        <div class="inv-stat is-gold"><strong>{copies()}</strong><span>Copies</span></div>
      </div>

      <p class="loc-box-line">
        Box <strong>{box()}</strong>
        <Show when={box() !== props.location}><span class="loc-box-alt"> (opened as {props.location})</span></Show>
      </p>

      <Show when={stacks().length} fallback={<div class="mypokoin-empty"><p class="inv-empty">Nothing stored in this box.</p><a class="btn" href="/inventory/scan">Scan cards</a></div>}>
        <div class="loc-list">
          <For each={stacks()}>
            {(stack) => (
              <div class="loc-stack">
                <div class="loc-stack-title">
                  <span class="loc-stack-no">{stackLabel(stack.stack)}</span>
                  <span class="loc-count">
                    <strong>{stack.postingCount}</strong>
                    {' '}
                    {stack.postingCount === 1 ? 'posting' : 'postings'}
                    {' · '}
                    {stack.copies} {stack.copies === 1 ? 'copy' : 'copies'}
                  </span>
                </div>
                <div class="loc-postings">
                  <For each={stack.postings}>
                    {(row) => {
                      const language = row?.language ? listingLanguageFlag(row.language) : null;
                      const slotPosition = row.slotPosition ? ` · pos ${row.slotPositionText || row.slotPosition}` : '';
                      return (
                        <a class="loc-posting" href={inventoryListingHref(row)}>
                          <RowThumb row={row} />
                          <span class="inv-card-txt">
                            <strong>{row?.cardName || row?.name || 'Listing'}</strong>
                            <span class="inv-card-sub">
                              {row?.setName || ''}{row?.collectorNumber ? `${row?.setName ? ' · ' : ''}#${row.collectorNumber}` : ''}
                              {slotPosition}
                            </span>
                          </span>
                          <span class="loc-stack-meta">
                            <img
                              class={`shop-cond is-${conditionTone(row.condition)}`}
                              src={conditionChipSrc(row.condition)}
                              alt={conditionShort(row.condition) || 'NM'}
                              title={conditionShort(row.condition) || 'NM'}
                              width="34"
                              height="24"
                              loading="lazy"
                            />
                            <Show when={language}><img class="inv-flag" src={language.src} alt={language.code} width="18" height="18" loading="lazy" /></Show>
                            <span class="inv-qty num">{Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0)}×</span>
                            <span class="inv-price num">{props.formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                            <span class={['inv-status', paused(row) ? 'is-paused' : 'is-live']}>{paused(row) ? 'Paused' : 'Live'}</span>
                          </span>
                        </a>
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
