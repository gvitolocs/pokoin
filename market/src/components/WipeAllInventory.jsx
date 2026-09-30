import { useState } from 'react';
import { getBearer } from '../auth.jsx';
import { wipeSellerInventory } from '../api.js';

export const WIPE_CONFIRM = 'DELETE ALL LISTINGS';

/**
 * Confirm-gated wipe of every Pokoin listing across TCGs (CardTrader stock untouched).
 */
export default function WipeAllInventory({
  disabled = false,
  onWiped = null,
  onError = null,
  onMessage = null,
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function onWipe() {
    if (busy || disabled || confirm !== WIPE_CONFIRM) return;
    setBusy(true);
    try {
      const bearer = await getBearer();
      const data = await wipeSellerInventory(bearer, { confirm: WIPE_CONFIRM });
      setOpen(false);
      setConfirm('');
      const message = `Deleted ${Number(data?.listingsRemoved || 0)} listings`
        + (data?.linksRemoved ? ` · ${data.linksRemoved} CardTrader links` : '')
        + '. Run Sync CardTrader on Profile to re-import.';
      onMessage?.(message);
      onWiped?.(data);
    } catch (err) {
      onError?.(err.message || 'Could not delete inventory.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ct-wipe">
      {!open ? (
        <button
          type="button"
          className="btn ghost ct-wipe-open"
          disabled={busy || disabled}
          onClick={() => {
            setOpen(true);
            setConfirm('');
            onError?.('');
          }}
        >
          Delete all inventory…
        </button>
      ) : (
        <div className="ct-wipe-panel" role="group" aria-label="Delete all inventory">
          <p className="ct-wipe-warn">
            This permanently deletes every Pokoin listing for your account across all TCGs
            (Pokémon and others), including CardTrader links. Your CardTrader stock is not
            deleted. Type <strong>{WIPE_CONFIRM}</strong> then confirm, then run Sync CardTrader
            on Profile to re-import.
          </p>
          <label className="ct-wipe-field">
            <span className="sr-only">Confirmation phrase</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={WIPE_CONFIRM}
              value={confirm}
              disabled={busy || disabled}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          <div className="ct-connect-actions">
            <button
              type="button"
              className="btn ct-wipe-confirm"
              disabled={busy || disabled || confirm !== WIPE_CONFIRM}
              onClick={onWipe}
            >
              {busy ? 'Deleting…' : 'Delete all listings'}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || disabled}
              onClick={() => {
                setOpen(false);
                setConfirm('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
