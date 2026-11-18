import { createEffect, createMemo, createSignal, Show } from 'solid-js';
import { fetchPriceCheck } from '@market/api.js';
import { priceCheckItem } from '@market/inventory-price.js';
import { listingOrigin } from '@market/inventory-origin.js';
import {
  cardFromInventoryRow,
  cardtraderLinked,
  identityFromInventoryRow,
  listingPresets,
  offerFromInventoryRow,
} from '@market/listing-row-edit.js';
import { getBearer } from '../../stores/auth.js';
import { sellerCurrency } from '../../stores/buyer.js';
import { useDialogFocus } from '../../lib/dialog-focus.js';
import ListingForm from '../desk/ListingForm.jsx';

/**
 * "Edit listing" as a drawer: the card desk's ListingForm in its `drawer`
 * variant, in a panel on the right edge with the board still readable behind
 * it. One row is open at a time — opening another switches this panel to it,
 * so the seller never stacks editors. Keyboard and focus come from the same
 * `useDialogFocus` helper the shared dialog shell uses.
 */
export default function ListingEditDrawer(props) {
  const row = () => props.row;
  const offer = createMemo(() => offerFromInventoryRow(row()));
  const card = createMemo(() => cardFromInventoryRow(row()));
  const identity = createMemo(() => identityFromInventoryRow(row()));
  const [fetched, setFetched] = createSignal([]);
  // Preview has no API: the quotes come straight from the fixture's comps.
  const presets = createMemo(() => (props.preview ? listingPresets(props.previewComps || {}, row()) : fetched()));
  const currencies = () => [...new Set(['PKN', sellerCurrency()])];
  // Imported listings are mirrored on the other side by the server, not the UI.
  const syncNote = () => {
    if (cardtraderLinked(row())) return 'Changes go to CardTrader too.';
    return listingOrigin(row()) === 'cardrails' ? 'Card Rails picks up the change on its next sync.' : '';
  };

  let box;
  const onKey = useDialogFocus(() => box, {
    onClose: () => props.onClose(),
    // The first thing to act on is the pricing menu, not the close button.
    first: () => box?.querySelector('.sell-pricing-btn'),
    // After a switch the button that opened this panel belongs to another row,
    // so the board gives the row last shown by id.
    restore: () => props.restoreFocus?.() || null,
  });

  // One price check for the row the drawer is on. The quotes are a
  // convenience, so a failure leaves the form without them, not blocked.
  createEffect(
    () => (props.preview ? null : { id: row()?.id, game: props.game }),
    (target) => {
      if (!target) return undefined;
      (async () => {
        try {
          const token = await getBearer();
          if (!token) return;
          const data = await fetchPriceCheck([priceCheckItem(row())], token, { game: props.game });
          setFetched(listingPresets(data?.prices, row()));
        } catch (_) {
          // The seller still types a price.
        }
      })();
      return undefined;
    },
  );

  async function removeRow() {
    if (!(await props.onDelete?.())) return;
    // The listing is gone: the board knows this close is not a discard, since a
    // flag written here would only be readable after this pass.
    props.onClose();
  }

  return (
    <div class="listing-drawer-scrim">
      <div
        class="listing-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="listing-drawer-title"
        onKeyDown={onKey}
        ref={(el) => { box = el; }}
      >
        <header class="listing-drawer-head">
          <span class="listing-drawer-id">
            <strong id="listing-drawer-title" class="thread-title">{card().name || 'Listing'}</strong>
            <span class="thread-meta">
              {[identity().set, identity().number ? `#${identity().number}` : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          <button type="button" class="listing-drawer-close" aria-label="Close" onClick={() => props.onClose()}>
            ×
          </button>
        </header>
        <div class="listing-drawer-main">
          <Show when={syncNote()}>
            <p class="thread-meta listing-drawer-note">{syncNote()}</p>
          </Show>
          <ListingForm
            variant="drawer"
            card={card()}
            identity={identity()}
            editing={offer()}
            presets={presets()}
            currencies={currencies()}
            moreFlags
            preview={props.preview}
            previewComps={props.previewComps}
            pricing={props.pricing}
            fromPath="/mypokoin/inventory"
            onFieldEdit={(dirty) => props.onDirty?.(dirty)}
            onCancelEdit={() => props.onClose()}
            onListed={(saved, note) => {
              props.onSaved?.(saved, note);
              props.onClose();
            }}
            // The listing saved but its pricing did not: the row follows while
            // the seller stays in the panel with the message.
            onRowUpdate={(saved) => props.onRowUpdated?.(saved)}
            onDelete={removeRow}
          />
        </div>
      </div>
    </div>
  );
}
