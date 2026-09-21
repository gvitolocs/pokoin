import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBearer } from '../auth.jsx';
import { fetchCardTraderStatus } from '../api.js';
import { fiatFromPkn, formatPknNumber } from '../pkn.js';
import { defaultInventoryTargets, inventoryTargetsLabel } from '../inventory-targets.js';

export { defaultInventoryTargets, inventoryTargetsLabel };

/**
 * Dual-target tile: Pokoin / CardTrader chips + primary action.
 * `mode` is "add" (scan) or "list" (desk).
 */
export default function InventoryTargets({
  mode = 'add',
  counts = { cards: 1 },
  intent = 'list',
  disabled = false,
  busy = false,
  busyLabel = 'Working…',
  pricePkn = null,
  onSubmit,
}) {
  const [connected, setConnected] = useState(false);
  // A CardTrader 1-Day Ready account: CardTrader lists its own warehouse stock,
  // so Pokoin cards are never pushed there.
  const [oneDayReady, setOneDayReady] = useState(false);
  const [statusReady, setStatusReady] = useState(false);
  const [targets, setTargets] = useState(() => defaultInventoryTargets(false));
  const touchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bearer = await getBearer();
        if (!bearer) {
          if (!cancelled) {
            setConnected(false);
            if (!touchedRef.current) {
              setTargets(defaultInventoryTargets(false));
            }
            setStatusReady(true);
          }
          return;
        }
        const data = await fetchCardTraderStatus(bearer);
        const ready1d = data?.status?.connected === true && data?.status?.metadata?.oneDayReady === true;
        const on = data?.status?.connected === true && !ready1d;
        if (!cancelled) {
          setConnected(on);
          setOneDayReady(ready1d);
          // Only seed defaults once — never overwrite a seller's chip toggles.
          if (!touchedRef.current) {
            setTargets(defaultInventoryTargets(on));
          } else if (!on) {
            setTargets((current) => (
              current.cardtrader ? { ...current, cardtrader: false } : current
            ));
          }
          setStatusReady(true);
        }
      } catch (_) {
        if (!cancelled) {
          setConnected(false);
          if (!touchedRef.current) {
            setTargets(defaultInventoryTargets(false));
          }
          setStatusReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function toggle(key) {
    setTargets((current) => {
      if (key === 'cardtrader' && !connected) {
        return current;
      }
      const next = { ...current, [key]: !current[key] };
      if (!next.pokoin && !next.cardtrader) {
        return current;
      }
      touchedRef.current = true;
      return next;
    });
  }

  const verb = mode === 'list' ? 'List' : 'Add';
  const label = mode === 'list' ? 'List on' : 'Add to';
  const showTargets = intent !== 'collection';
  const eur = showTargets && targets.cardtrader && pricePkn != null
    ? fiatFromPkn(pricePkn, 'EUR')
    : null;
  const actionLabel = busy
    ? busyLabel
    : inventoryTargetsLabel(counts, { intent, targets, verb });

  return (
    <div className={`inventory-targets${showTargets ? '' : ' is-simple'}`}>
      {showTargets ? (
        <div className="inventory-targets-tile" role="group" aria-label={label}>
          <span className="inventory-targets-label">{label}</span>
          <div className="inventory-targets-chips">
            <button
              type="button"
              className={targets.pokoin ? 'on' : ''}
              aria-pressed={targets.pokoin}
              disabled={disabled || busy}
              onClick={() => toggle('pokoin')}
            >
              Pokoin
            </button>
            <button
              type="button"
              className={targets.cardtrader ? 'on' : ''}
              aria-pressed={targets.cardtrader}
              disabled={disabled || busy || !connected}
              title={connected
                ? 'List on CardTrader'
                : oneDayReady
                  ? 'CardTrader lists 1-Day Ready stock itself'
                  : 'Connect CardTrader in Profile'}
              onClick={() => toggle('cardtrader')}
            >
              CardTrader
            </button>
          </div>
          {!connected && statusReady && oneDayReady ? (
            <span className="inventory-targets-hint">1-Day Ready: Pokoin only</span>
          ) : null}
          {!connected && statusReady && !oneDayReady ? (
            <Link className="inventory-targets-hint" to="/profile">Connect in Profile</Link>
          ) : null}
          {eur != null ? (
            <span className="inventory-targets-eur">
              ≈ €{formatPknNumber(eur, { maximumFractionDigits: 2 })} on CardTrader
            </span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className={`btn ${mode === 'list' ? 'list-btn' : 'scan-submit'}`}
        disabled={disabled || busy || (showTargets && !statusReady)}
        onClick={() => onSubmit?.(targets)}
        title={mode === 'add' ? '⌘Enter' : undefined}
      >
        {actionLabel}
      </button>
    </div>
  );
}
