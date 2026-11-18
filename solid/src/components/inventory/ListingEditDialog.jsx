import { createMemo, createSignal, onMount, Show } from 'solid-js';
import { fetchPriceCheck } from '@market/api.js';
import { priceCheckItem } from '@market/inventory-price.js';
import { listingOrigin, originLabel } from '@market/inventory-origin.js';
import { conditionChipSrc, conditionShort, conditionTone } from '@market/listing-meta.js';
import {
  cardFromInventoryRow,
  cardtraderLinked,
  identityFromInventoryRow,
  listingPresets,
  offerFromInventoryRow,
} from '@market/listing-row-edit.js';
import { getBearer } from '../../stores/auth.js';
import { sellerCurrency } from '../../stores/buyer.js';
import ListingForm from '../desk/ListingForm.jsx';
import RowThumb from './RowThumb.jsx';
import { ZeroDialog } from '../zero/ZeroDialogs.jsx';

/**
 * "Edit listing" for one inventory row: the card desk's listing form inside the
 * shared dialog shell, so the seller edits an ask without leaving the board.
 * The row is all the editor has, so the card, its identity and the offer come
 * from listing-row-edit helpers instead of a desk page.
 */
export default function ListingEditDialog(props) {
  const row = () => props.row;
  const offer = createMemo(() => offerFromInventoryRow(row()));
  const card = createMemo(() => cardFromInventoryRow(row()));
  const identity = createMemo(() => identityFromInventoryRow(row()));
  const origin = createMemo(() => listingOrigin(row()));
  const [presets, setPresets] = createSignal([]);
  const currencies = () => [...new Set(['PKN', sellerCurrency()])];
  // Imported listings are mirrored on the other side by the server, not the UI.
  const syncNote = () => {
    if (cardtraderLinked(row())) return 'Changes are sent to CardTrader too.';
    return origin() === 'cardrails' ? 'Card Rails picks up the change on its next sync.' : '';
  };

  onMount(() => {
    (async () => {
      if (props.preview) {
        setPresets(listingPresets(props.previewComps || {}, row()));
        return;
      }
      try {
        const token = await getBearer();
        if (!token) return;
        const data = await fetchPriceCheck([priceCheckItem(row())], token, { game: props.game });
        setPresets(listingPresets(data?.prices, row()));
      } catch {
        // The quotes are a convenience; the form works without them.
      }
    })();
  });

  async function removeRow() {
    if (await props.onDelete?.()) props.onClose();
  }

  return (
    <ZeroDialog titleId="listing-edit-title" title="Edit listing" onClose={() => props.onClose()}>
      <div class="listing-edit-head">
        <RowThumb row={row()} />
        <span class="listing-edit-id">
          <strong class="thread-title">{card().name || 'Listing'}</strong>
          <span class="thread-meta">
            {[identity().set, identity().number ? `#${identity().number}` : ''].filter(Boolean).join(' · ')}
          </span>
        </span>
        <img
          class={`shop-cond is-${conditionTone(offer().condition)}`}
          src={conditionChipSrc(offer().condition)}
          alt={conditionShort(offer().condition) || 'NM'}
          title={conditionShort(offer().condition) || 'NM'}
          width="34"
          height="24"
        />
        <span class={`inv-origin is-${origin()}`} title={`Listed from ${originLabel(origin())}`}>
          {originLabel(origin())}
        </span>
      </div>
      <Show when={syncNote()}><p class="thread-meta listing-edit-note">{syncNote()}</p></Show>
      <ListingForm
        card={card()}
        identity={identity()}
        editing={offer()}
        presets={presets()}
        currencies={currencies()}
        moreFlags
        preview={props.preview}
        fromPath="/mypokoin/inventory"
        onCancelEdit={() => props.onClose()}
        onListed={(saved) => {
          props.onSaved?.(saved);
          props.onClose();
        }}
        onDelete={removeRow}
      />
    </ZeroDialog>
  );
}
