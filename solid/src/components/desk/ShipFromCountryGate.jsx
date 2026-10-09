import { For, Show } from 'solid-js';
import { SHIP_FROM_COUNTRIES, shipFromCountryOptionLabel } from '@market/ship-countries.js';

/**
 * First listing without a ship-from country (market/src/components/
 * SellerShippingSettings.jsx ShipFromCountryGate, with Desk.jsx Alert inline).
 */
export default function ShipFromCountryGate(props) {
  return (
    <Show when={props.open}>
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Ship from country">
        <div class="modal-card desk-panel">
          <h2>Where do you ship from?</h2>
          <p class="page-lede">
            We could not detect your country from this connection. Choose the country you mail cards from — required before selling. You can change it later in Profile.
          </p>
          <Show when={props.error}><p class="desk-alert" role="status">{props.error}</p></Show>
          <label class="sell-field">
            Country
            <select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
              <option value="" selected={!props.value}>Select country</option>
              <For each={SHIP_FROM_COUNTRIES}>
                {(row) => (
                  <option value={row.code} selected={row.code === props.value}>
                    {shipFromCountryOptionLabel(row.code)}
                  </option>
                )}
              </For>
            </select>
          </label>
          <div class="modal-actions">
            <button class="btn" type="button" disabled={props.busy || !props.value} onClick={() => props.onSave()}>
              {props.busy ? 'Saving…' : 'Save and continue'}
            </button>
            <button class="btn ghost" type="button" onClick={() => props.onClose()}>Cancel</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
