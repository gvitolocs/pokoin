import { createEffect, createSignal, For, Show } from 'solid-js';
import { savePricingStrategies } from '@market/api.js';
import { PRICER_CURRENCIES } from '@market/pricer.js';
import { getBearer } from '../../stores/auth.js';

const DEFAULT_PRICER = { defaultSource: 'cardtrader', autoMarketColumn: false, currency: 'EUR' };

/** Pricer defaults editor (MyPokoin settings tab). */
export default function PricerDefaults(props) {
  const [draft, setDraft] = createSignal(props.settings || DEFAULT_PRICER);
  const [saved, setSaved] = createSignal(false);
  // Follow the parent whenever it loads new settings (a cached copy may
  // predate `currency`: it reads EUR).
  createEffect(() => setDraft(props.settings ? { ...DEFAULT_PRICER, ...props.settings } : DEFAULT_PRICER));

  async function save(next) {
    setDraft(next);
    setSaved(false);
    if (props.preview) {
      props.onSaved?.(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return;
    }
    const token = await getBearer();
    const data = await savePricingStrategies({ pricerSettings: next }, token);
    props.onSaved?.(data.pricerSettings || next, data.currencyRate ?? null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div class="ps-defaults">
      <label class="ps-field">
        <span>Default pricer source</span>
        <select value={draft().defaultSource} onChange={(event) => save({ ...draft(), defaultSource: event.target.value })}>
          <option value="cardtrader">CardTrader</option>
          <option value="pokoin">Pokoin</option>
        </select>
      </label>
      <label class="ps-field">
        <span>Currency</span>
        <select value={draft().currency || 'EUR'} onChange={(event) => save({ ...draft(), currency: event.target.value })}>
          <For each={PRICER_CURRENCIES}>{(code) => <option value={code}>{code}</option>}</For>
        </select>
        <small>The pricer shows and accepts prices in this currency.</small>
      </label>
      <label class="ps-field ps-check">
        <input
          type="checkbox"
          checked={draft().autoMarketColumn === true}
          onChange={(event) => save({ ...draft(), autoMarketColumn: event.target.checked })}
        />
        <span>Show the market column on the listings board</span>
      </label>
      <Show when={saved()}><span class="ct-connect-ok">Saved.</span></Show>
    </div>
  );
}
