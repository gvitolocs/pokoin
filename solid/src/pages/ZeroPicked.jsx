import { createEffect, createSignal, For, Show, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { fetchCardTraderZeroPicked, saveCardTraderZeroPick } from '@market/api.js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '@market/listing-meta.js';
import { formatOrderMoney } from '@market/order-status.js';
import '@market/zero-pack.css';
import { Alert, DeskPanel, EmptyDesk } from '../components/Desk.jsx';
import RowThumb from '../components/inventory/RowThumb.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { getBearer, signedIn } from '../stores/auth.js';
import {
  allowMypokoinPreview,
  MYPOKOIN_PREVIEW_BANNER,
  previewZeroPicked,
} from './mypokoin-preview-fixture.js';

function pickedWhen(value) {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
}

function rowFacets(row) {
  return [
    row.reverse ? 'Reverse' : '',
    row.firstEdition ? '1st ed.' : '',
    row.kind === 'swap' ? 'Swapped box' : '',
  ].filter(Boolean);
}

/** The undo body: reverses exactly the recorded pick (the server finds it by order, item, listing). */
export function undoBody(row) {
  return {
    orderId: String(row.orderId),
    itemId: String(row.itemId),
    lineKey: String(row.lineKey || `${row.itemId}@${row.listingId}`),
    listingId: String(row.listingId),
    allocatedListingId: String(row.allocatedListingId || ''),
    quantity: Math.max(1, Number(row.quantity) || 1),
    action: 'undo',
  };
}

/**
 * Picked Zero copies: they left the sellable inventory when picked. Not
 * listings: never in Listings, stock counts, or totals. Undo puts one back.
 */
function PickedDesk(props) {
  const [rows, setRows] = createSignal(props.preview ? previewZeroPicked().rows : null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal([]);
  const [notes, setNotes] = createSignal({});
  const flight = new Set();

  async function load() {
    setError('');
    try {
      const token = await getBearer();
      const data = await fetchCardTraderZeroPicked(token);
      setRows(() => data?.rows || []);
    } catch (err) {
      setError(err.message || 'Picked cards failed to load.');
      setRows((current) => current || []);
    }
  }

  createEffect(signedIn, (on) => {
    if (props.preview || !on) return;
    load();
  });

  async function undo(row) {
    const key = String(row.id);
    if (flight.has(key)) return;
    flight.add(key);
    setBusy((keys) => [...keys, key]);
    try {
      if (!props.preview) {
        const token = await getBearer();
        await saveCardTraderZeroPick(token, undoBody(row));
      }
      setRows((list) => (list || []).filter((other) => String(other.id) !== key));
      setNotes((all) => ({ ...all, last: `${row.name || 'Card'} is back in inventory${row.locationFrom ? ` (${row.locationFrom})` : ''}.` }));
    } catch (err) {
      setError(err?.body?.code === 'allocated_copy_gone'
        ? 'The sold copy is no longer in your inventory, so this pick cannot be undone.'
        : err.message || 'Undo failed.');
    } finally {
      flight.delete(key);
      setBusy((keys) => keys.filter((other) => other !== key));
    }
  }

  const copies = () => (rows() || []).reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);

  return (
    <div class="page desk mypokoin">
      <Show when={props.preview}>
        <p class="seller-preview-banner" role="status">{MYPOKOIN_PREVIEW_BANNER}</p>
      </Show>
      <StockNav
        title="Picked"
        lede="Copies you picked for CardTrader Zero shipments. They are out of your inventory."
        metrics={rows() ? [
          { value: rows().length, label: 'Picks' },
          { value: copies(), label: 'Copies picked' },
        ] : []}
      >
        <button class="btn ghost" type="button" onClick={load} disabled={props.preview}>Reload</button>
      </StockNav>
      <p class="mypokoin-help">A picked copy left your sellable inventory, so it is not in Listings or your stock totals. Undo puts it back where it came from.</p>
      <Alert>{error()}</Alert>
      <Show when={notes().last}><p class="desk-ok" role="status">{notes().last}</p></Show>

      <Show when={rows()} fallback={<DeskPanel title="Picked"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>}>
        <Show
          when={rows().length}
          fallback={<EmptyDesk title="Nothing picked yet" lede="Cards you pick on the CardTrader Zero list show up here." />}
        >
          <DeskPanel flush title="Picked cards">
            <div class="zero-picked-table" role="table" aria-label="Picked cards">
              <div class="zero-picked-row is-head" role="row">
                <span role="columnheader">Card</span>
                <span role="columnheader">Details</span>
                <span role="columnheader">Came from</span>
                <span role="columnheader">Zero shipment</span>
                <span role="columnheader">Picked at</span>
                <span role="columnheader">Sold for</span>
                <span role="columnheader"><span class="sr-only">Actions</span></span>
              </div>
              <For each={rows()}>
                {(row) => {
                  const language = () => (row.language ? listingLanguageFlag(row.language) : null);
                  const working = () => busy().includes(String(row.id));
                  return (
                    <div class="zero-picked-row" role="row">
                      <span class="zero-picked-card" role="cell">
                        <RowThumb row={{ cardId: row.cardId, cardName: row.name, cardImageUrl: row.imageUrl }} />
                        <span>
                          <Show when={row.cardId} fallback={<strong>{row.name}</strong>}>
                            <a href={inventoryListingHref(row)}><strong>{row.name}</strong></a>
                          </Show>
                          <small class="thread-meta">
                            {[row.collectorNumber ? `#${row.collectorNumber}` : '', row.expansion].filter(Boolean).join(' · ')}
                          </small>
                        </span>
                      </span>
                      <span class="zero-tile-badges" role="cell">
                        <Show when={row.condition}>
                          <img
                            class={['shop-cond', `is-${conditionTone(row.condition)}`]}
                            src={conditionChipSrc(row.condition)}
                            alt={conditionShort(row.condition)}
                            title={row.condition}
                            width="34"
                            height="24"
                            loading="lazy"
                          />
                        </Show>
                        <Show when={language()}>
                          {(lang) => <img class="inv-flag" src={lang().src} alt={lang().label} title={lang().label} width="18" height="18" loading="lazy" />}
                        </Show>
                        <For each={rowFacets(row)}>{(facet) => <span class="zero-facet">{facet}</span>}</For>
                        <Show when={Number(row.quantity) > 1}><span class="zero-take">×{row.quantity}</span></Show>
                      </span>
                      <span role="cell">{row.locationFrom || 'No location'}</span>
                      <span role="cell">
                        <a href="/mypokoin/zero">{row.orderCode || row.orderId}</a>
                        <small class="thread-meta"> order {row.orderId}</small>
                      </span>
                      <span role="cell" class="thread-meta">{pickedWhen(row.pickedAt)}</span>
                      <span role="cell" class="num">
                        {row.unitCents != null ? formatOrderMoney(row.unitCents * (Number(row.quantity) || 1), row.currency) : '—'}
                      </span>
                      <span role="cell">
                        <button class="btn ghost" type="button" disabled={working()} onClick={() => undo(row)}>
                          {working() ? 'Undoing…' : 'Undo (back to inventory)'}
                        </button>
                      </span>
                    </div>
                  );
                }}
              </For>
            </div>
          </DeskPanel>
        </Show>
      </Show>
    </div>
  );
}

/** /mypokoin/picked: the seller's picked Zero copies. */
export default function ZeroPicked() {
  document.title = 'Picked · Pokoin';
  const [params] = useSearchParams();
  return (
    <Show
      when={untrack(() => allowMypokoinPreview(params))}
      fallback={(
        <SignedIn early from="/mypokoin/picked">
          <PickedDesk />
        </SignedIn>
      )}
    >
      <PickedDesk preview />
    </Show>
  );
}
