import { createSignal, Show } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { authFrom } from '@market/punchouts.js';
import { sellTarget } from '../../lib/buy-book.js';
import { useGameNavigate } from '../../lib/game-navigate.js';
import { signedIn } from '../../stores/auth.js';
import QuickSellDialog from './QuickSellDialog.jsx';
import { rowThumbSrc } from '../inventory/RowThumb.jsx';

/**
 * The `Sell now` button on a BuySell row. It opens the same Quick Sell dialog
 * the card desk uses, with this row as the exact target: its own order id,
 * price and remaining copies, never an aggregate of several buyers.
 * props.order is a board item (`/buysell`) or a matching offer (`?tab=sell`);
 * props.preview skips sign-in and the API call (layout preview).
 */
export default function SellNowForm(props) {
  const navigate = useGameNavigate();
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  const target = () => sellTarget(props.order);
  const card = () => ({
    name: props.order?.card_name || props.order?.cardName || '',
    imageUrl: rowThumbSrc(props.order),
    set: props.order?.set_name || props.order?.setName || '',
    number: props.order?.collector_number || props.order?.collectorNumber || '',
  });

  function begin() {
    if (!props.preview && !signedIn()) {
      navigate(authFrom(props.fromPath || `${location.pathname}${location.search}` || '/marketplace'));
      return;
    }
    if (!target()) return;
    setOpen(true);
  }

  return (
    <div class="sell-now">
      <Show when={!open()}>
        <button type="button" class="btn ghost sell-now-btn" onClick={begin}>Sell now</button>
      </Show>
      <Show when={open()}>
        <QuickSellDialog
          target={target()}
          cardId={props.order?.card_id || props.order?.cardId}
          card={card()}
          buyerName={props.order?.buyer_name || props.order?.buyerName || ''}
          preview={props.preview}
          fromPath={props.fromPath || `${location.pathname}${location.search}`}
          onClose={() => setOpen(false)}
          onDone={props.onDone}
        />
      </Show>
    </div>
  );
}
