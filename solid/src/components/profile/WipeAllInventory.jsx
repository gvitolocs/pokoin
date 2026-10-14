import { createSignal, Show } from 'solid-js';
import { wipeSellerInventory } from '@market/api.js';
import { getBearer } from '../../stores/auth.js';

export const WIPE_CONFIRM = 'DELETE ALL LISTINGS';

/** Confirm-gated wipe of every Pokoin listing across TCGs (market/src/components/WipeAllInventory.jsx). */
export default function WipeAllInventory(props) {
  const [open, setOpen] = createSignal(false);
  const [confirm, setConfirm] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const disabled = () => Boolean(props.disabled);

  async function onWipe() {
    if (busy() || disabled() || confirm() !== WIPE_CONFIRM) return;
    setBusy(true);
    try {
      const bearer = await getBearer();
      const data = await wipeSellerInventory(bearer, { confirm: WIPE_CONFIRM });
      setOpen(false);
      setConfirm('');
      const message = `Deleted ${Number(data?.listingsRemoved || 0)} listings`
        + (data?.linksRemoved ? ` · ${data.linksRemoved} CardTrader links` : '')
        + '. Run Sync CardTrader on Profile to re-import.';
      props.onMessage?.(message);
      props.onWiped?.(data);
    } catch (err) {
      props.onError?.(err.message || 'Could not delete inventory.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="ct-wipe">
      <Show
        when={open()}
        fallback={(
          <button
            type="button"
            class="btn ghost ct-wipe-open"
            disabled={busy() || disabled()}
            onClick={() => {
              setOpen(true);
              setConfirm('');
              props.onError?.('');
            }}
          >
            Delete all inventory…
          </button>
        )}
      >
        <div class="ct-wipe-panel" role="group" aria-label="Delete all inventory">
          <p class="ct-wipe-warn">
            This permanently deletes every Pokoin listing for your account across all TCGs
            (Pokémon and others), including CardTrader links. Your CardTrader stock is not
            deleted. Type <strong>{WIPE_CONFIRM}</strong> then confirm, then run Sync CardTrader
            on Profile to re-import.
          </p>
          <label class="ct-wipe-field">
            <span class="sr-only">Confirmation phrase</span>
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder={WIPE_CONFIRM}
              value={confirm()}
              disabled={busy() || disabled()}
              onInput={(event) => setConfirm(event.target.value)}
            />
          </label>
          <div class="ct-connect-actions">
            <button type="button" class="btn ct-wipe-confirm" disabled={busy() || disabled() || confirm() !== WIPE_CONFIRM} onClick={onWipe}>
              {busy() ? 'Deleting…' : 'Delete all listings'}
            </button>
            <button type="button" class="btn ghost" disabled={busy() || disabled()} onClick={() => { setOpen(false); setConfirm(''); }}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
