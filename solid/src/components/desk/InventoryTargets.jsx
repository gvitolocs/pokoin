import { createSignal, onSettled, Show } from 'solid-js';
import { fetchCardTraderStatus } from '@market/api.js';
import { defaultInventoryTargets, inventoryTargetsLabel } from '@market/inventory-targets.js';
import { fiatFromPkn, formatPknNumber } from '@market/pkn.js';
import { getBearer, signedIn } from '../../stores/auth.js';

/**
 * Pokoin / CardTrader target chips + primary action
 * (market/src/components/InventoryTargets.jsx). `mode` is "add" or "list".
 * Signed-out visitors skip the bearer so the desk never loads Firebase for them.
 */
export default function InventoryTargets(props) {
  const [connected, setConnected] = createSignal(false);
  // A CardTrader 1-Day Ready account: CardTrader lists its own warehouse stock,
  // so Pokoin cards are never pushed there.
  const [oneDayReady, setOneDayReady] = createSignal(false);
  const [statusReady, setStatusReady] = createSignal(false);
  const [targets, setTargets] = createSignal(defaultInventoryTargets(false));
  let touched = false;

  onSettled(() => {
    let cancelled = false;
    (async () => {
      try {
        const bearer = signedIn() ? await getBearer() : '';
        if (!bearer) {
          if (cancelled) return;
          setConnected(false);
          if (!touched) setTargets(defaultInventoryTargets(false));
          setStatusReady(true);
          return;
        }
        const data = await fetchCardTraderStatus(bearer);
        const ready1d = data?.status?.connected === true && data?.status?.metadata?.oneDayReady === true;
        const on = data?.status?.connected === true && !ready1d;
        if (cancelled) return;
        setConnected(on);
        setOneDayReady(ready1d);
        // Only seed defaults once — never overwrite a seller's chip toggles.
        if (!touched) {
          setTargets(defaultInventoryTargets(on));
        } else if (!on) {
          setTargets((current) => (current.cardtrader ? { ...current, cardtrader: false } : current));
        }
        setStatusReady(true);
      } catch (_) {
        if (cancelled) return;
        setConnected(false);
        if (!touched) setTargets(defaultInventoryTargets(false));
        setStatusReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function toggle(key) {
    setTargets((current) => {
      if (key === 'cardtrader' && !connected()) return current;
      const next = { ...current, [key]: !current[key] };
      if (!next.pokoin && !next.cardtrader) return current;
      touched = true;
      return next;
    });
  }

  const mode = () => props.mode || 'add';
  const intent = () => props.intent || 'list';
  const verb = () => (mode() === 'list' ? 'List' : 'Add');
  const label = () => (mode() === 'list' ? 'List on' : 'Add to');
  const showTargets = () => intent() !== 'collection';
  const eur = () => (showTargets() && targets().cardtrader && props.pricePkn != null
    ? fiatFromPkn(props.pricePkn, 'EUR')
    : null);
  const actionLabel = () => (props.busy
    ? (props.busyLabel || 'Working…')
    : inventoryTargetsLabel(props.counts || { cards: 1 }, { intent: intent(), targets: targets(), verb: verb() }));

  return (
    <div class={['inventory-targets', { 'is-simple': !showTargets() }]}>
      <Show when={showTargets()}>
        <div class="inventory-targets-tile" role="group" aria-label={label()}>
          <span class="inventory-targets-label">{label()}</span>
          <div class="inventory-targets-chips">
            <button
              type="button"
              class={targets().pokoin ? 'on' : ''}
              aria-pressed={targets().pokoin ? 'true' : 'false'}
              disabled={props.disabled || props.busy}
              onClick={() => toggle('pokoin')}
            >
              Pokoin
            </button>
            <button
              type="button"
              class={targets().cardtrader ? 'on' : ''}
              aria-pressed={targets().cardtrader ? 'true' : 'false'}
              disabled={props.disabled || props.busy || !connected()}
              title={connected()
                ? 'List on CardTrader'
                : oneDayReady()
                  ? 'CardTrader lists 1-Day Ready stock itself'
                  : 'Connect CardTrader in Profile'}
              onClick={() => toggle('cardtrader')}
            >
              CardTrader
            </button>
          </div>
          <Show when={!connected() && statusReady() && oneDayReady()}>
            <span class="inventory-targets-hint">1-Day Ready: Pokoin only</span>
          </Show>
          <Show when={!connected() && statusReady() && !oneDayReady()}>
            <a class="inventory-targets-hint" href="/profile">Connect in Profile</a>
          </Show>
          <Show when={eur() != null}>
            <span class="inventory-targets-eur">
              ≈ €{formatPknNumber(eur(), { maximumFractionDigits: 2 })} on CardTrader
            </span>
          </Show>
        </div>
      </Show>
      <button
        type="button"
        class={['btn', mode() === 'list' ? 'list-btn' : 'scan-submit']}
        disabled={props.disabled || props.busy || (showTargets() && !statusReady())}
        onClick={() => props.onSubmit?.(targets())}
        title={mode() === 'add' ? '⌘Enter' : undefined}
      >
        {actionLabel()}
      </button>
    </div>
  );
}
