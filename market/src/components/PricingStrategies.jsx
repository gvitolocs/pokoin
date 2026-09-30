import { useEffect, useState } from 'react';
import { deletePricingStrategy, fetchPriceCheck, fetchPricingStrategies, fetchSellerListings, savePricingStrategies, updateListing } from '../api.js';
import { useAuth } from '../auth.jsx';
import { liveInventoryListings, strategyMatchesListing } from '../inventory-listings.js';

const SOURCES = [
  { id: 'pokoin', label: 'Pokoin' },
  { id: 'cardtrader', label: 'CardTrader' },
];

const ACTIONS = [
  { id: 'match', label: 'Match the market price' },
  { id: 'undercut', label: 'Undercut the market' },
  { id: 'premium', label: 'Sit above the market' },
];

const EMPTY_STRATEGY = {
  id: '',
  name: '',
  source: 'cardtrader',
  action: 'undercut',
  amountPct: 5,
  amountPkn: 0,
  minPkn: 1,
  rounding: 'integer',
  condition: '',
  language: '',
  enabled: true,
};

function summaryLine(strategy) {
  const parts = [];
  parts.push(strategy.source === 'pokoin' ? 'Pokoin' : 'CardTrader');
  if (strategy.action === 'match') parts.push('match market');
  if (strategy.action === 'undercut') parts.push(`undercut ${strategy.amountPct || 0}%${strategy.amountPkn ? ` − ${strategy.amountPkn} PKN` : ''}`);
  if (strategy.action === 'premium') parts.push(`+${strategy.amountPct || 0}%${strategy.amountPkn ? ` + ${strategy.amountPkn} PKN` : ''}`);
  if (strategy.minPkn) parts.push(`min ${strategy.minPkn} PKN`);
  if (strategy.rounding === 'integer') parts.push('rounded');
  if (strategy.condition) parts.push(strategy.condition);
  if (strategy.language) parts.push(strategy.language);
  return parts.join(' · ');
}

function targetFor(compPkn, strategy) {
  if (!(Number(compPkn) > 0)) return null;
  let target = Number(compPkn);
  const pct = Number(strategy.amountPct) || 0;
  const flat = Number(strategy.amountPkn) || 0;
  if (strategy.action === 'undercut') target = target * (1 - pct / 100) - flat;
  else if (strategy.action === 'premium') target = target * (1 + pct / 100) + flat;
  if (strategy.rounding === 'integer') target = Math.round(target);
  const min = Number(strategy.minPkn) || 0;
  if (min > 0) target = Math.max(target, min);
  if (!(target > 0)) return null;
  return Math.round(target * 100) / 100;
}

/**
 * PowerTools-style pricing strategies: create any number of rules
 * (source + action + amount + scope + floor + rounding), then apply one to
 * the live inventory with a dry-run preview before the batch reprice.
 */
export default function PricingStrategies({ onApplied }) {
  const { user, profile, getBearer } = useAuth();
  const [strategies, setStrategies] = useState(null);
  const [pricerSettings, setPricerSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [applyState, setApplyState] = useState(null);

  async function load() {
    const token = await getBearer();
    const data = await fetchPricingStrategies(token);
    setStrategies(data.strategies || []);
    setPricerSettings(data.pricerSettings || {});
  }

  useEffect(() => {
    if (!signedInSafe()) return undefined;
    let cancelled = false;
    load().catch((err) => !cancelled && setError(err.message || 'Could not load strategies.'));
    return () => { cancelled = true; };
    function signedInSafe() { return Boolean(user?.uid || profile?.uid); }
  }, [user?.uid, profile?.uid, getBearer]);

  async function persist(body, note = 'Saved.') {
    setBusy('save');
    setError('');
    try {
      const token = await getBearer();
      const data = await savePricingStrategies(body, token);
      setStrategies(data.strategies || []);
      setPricerSettings(data.pricerSettings || {});
      setDraft(null);
    } catch (err) {
      setError(err.message || 'Save failed.');
    } finally {
      setBusy('');
    }
  }

  async function remove(id) {
    setBusy(id);
    setError('');
    try {
      const token = await getBearer();
      const data = await deletePricingStrategy(id, token);
      setStrategies(data.strategies || []);
    } catch (err) {
      setError(err.message || 'Delete failed.');
    } finally {
      setBusy('');
    }
  }

  /** Dry-run: comps for matching rows, then the computed targets. */
  async function openApply(strategy) {
    setBusy(`apply-${strategy.id}`);
    setError('');
    setApplyState(null);
    try {
      const uid = user?.uid || profile?.uid;
      const token = await getBearer();
      const data = await fetchSellerListings(uid, token, { limit: 1000 });
      const rows = liveInventoryListings(data.listings || data.items || [])
        .filter((row) => strategyMatchesListing(strategy, row));
      const items = rows.slice(0, 100).map((row) => ({
        cardId: String(row?.cardId || row?.card_id || ''),
        condition: String(row?.condition || 'NM').toUpperCase(),
        language: String(row?.language || '').toUpperCase(),
      })).filter((item) => /^\d+$/.test(item.cardId));
      const comps = items.length ? await fetchPriceCheck(items, token) : { prices: {} };
      const plan = rows.slice(0, 100).map((row) => {
        const cardId = String(row?.cardId || row?.card_id || '');
        const comp = comps.prices?.[cardId] || {};
        const compPkn = strategy.source === 'pokoin'
          ? (comp.pokoinCheapestPkn ?? comp.soldMedianPkn ?? null)
          : (comp.ctMatchedPkn ?? comp.ctCheapestPkn ?? null);
        const current = Number(row?.pricePkn ?? row?.price_pkn ?? 0) || 0;
        const target = targetFor(compPkn, strategy);
        return { row, current, compPkn, target };
      }).filter((entry) => entry.target != null && Math.abs(entry.target - entry.current) >= 0.01);
      setApplyState({ strategy, plan, done: false, progress: 0 });
    } catch (err) {
      setError(err.message || 'Could not build the reprice preview.');
    } finally {
      setBusy('');
    }
  }

  async function runApply() {
    const { strategy, plan } = applyState;
    setBusy('run');
    setError('');
    let done = 0;
    try {
      const token = await getBearer();
      for (const entry of plan) {
        await updateListing(entry.row.id, { pricePkn: entry.target }, token);
        done += 1;
        setApplyState((state) => ({ ...state, progress: done }));
      }
      setApplyState((state) => ({ ...state, done: true }));
      load().catch(() => {});
      onApplied?.();
    } catch (err) {
      setError(`Repricing stopped at ${done}/${plan.length}: ${err.message || 'update failed.'}`);
      setApplyState((state) => ({ ...state, done: true }));
    } finally {
      setBusy('');
    }
  }

  const editor = draft;

  return (
    <div className="ps-wrap">
      {error ? <p className="ct-connect-err" role="alert">{error}</p> : null}

      {!editor ? (
        <button type="button" className="btn" onClick={() => setDraft({ ...EMPTY_STRATEGY })}>
          New pricing strategy
        </button>
      ) : (
        <div className="ps-editor" data-testid="strategy-editor">
          <h3>{editor.id ? 'Edit strategy' : 'New pricing strategy'}</h3>
          <div className="ps-grid">
            <label className="ps-field">
              <span>Name</span>
              <input
                value={editor.name}
                onChange={(event) => setDraft({ ...editor, name: event.target.value })}
                placeholder="Undercut CardTrader by 5%"
              />
            </label>
            <label className="ps-field">
              <span>Comp source</span>
              <select value={editor.source} onChange={(event) => setDraft({ ...editor, source: event.target.value })}>
                {SOURCES.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
              </select>
            </label>
            <label className="ps-field">
              <span>Action</span>
              <select value={editor.action} onChange={(event) => setDraft({ ...editor, action: event.target.value })}>
                {ACTIONS.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
              </select>
            </label>
            {editor.action !== 'match' ? (
              <>
                <label className="ps-field">
                  <span>Amount %</span>
                  <input
                    type="number" min="0" max="90" step="0.5"
                    value={editor.amountPct}
                    onChange={(event) => setDraft({ ...editor, amountPct: Number(event.target.value) })}
                  />
                </label>
                <label className="ps-field">
                  <span>Plus PKN</span>
                  <input
                    type="number" min="0" step="1"
                    value={editor.amountPkn}
                    onChange={(event) => setDraft({ ...editor, amountPkn: Number(event.target.value) })}
                  />
                </label>
              </>
            ) : null}
            <label className="ps-field">
              <span>Floor PKN</span>
              <input
                type="number" min="0" step="1"
                value={editor.minPkn}
                onChange={(event) => setDraft({ ...editor, minPkn: Number(event.target.value) })}
              />
            </label>
            <label className="ps-field">
              <span>Rounding</span>
              <select value={editor.rounding} onChange={(event) => setDraft({ ...editor, rounding: event.target.value })}>
                <option value="none">Exact</option>
                <option value="integer">Whole PKN</option>
              </select>
            </label>
            <label className="ps-field">
              <span>Condition scope</span>
              <select value={editor.condition} onChange={(event) => setDraft({ ...editor, condition: event.target.value })}>
                <option value="">All conditions</option>
                {['NM', 'SP', 'MP', 'PL', 'Poor'].map((key) => <option key={key} value={key}>{key}</option>)}
              </select>
            </label>
            <label className="ps-field">
              <span>Language scope</span>
              <select value={editor.language} onChange={(event) => setDraft({ ...editor, language: event.target.value })}>
                <option value="">All languages</option>
                {['EN', 'IT', 'DE', 'FR', 'ES', 'JP', 'KO', 'PT', 'NL', 'PL', 'RU', 'ZH', 'ZHT'].map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </label>
            <label className="ps-field ps-check">
              <input
                type="checkbox"
                checked={editor.enabled}
                onChange={(event) => setDraft({ ...editor, enabled: event.target.checked })}
              />
              <span>Enabled</span>
            </label>
          </div>
          <div className="ps-actions">
            <button
              type="button"
              className="btn"
              disabled={busy === 'save' || !editor.name}
              onClick={() => persist({ strategy: editor })}
            >
              {busy === 'save' ? 'Saving…' : 'Save strategy'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      {strategies === null ? (
        <p className="seller-panel-empty">Loading strategies…</p>
      ) : !strategies.length ? (
        <p className="seller-panel-empty">
          No pricing strategies yet. A strategy reprices matching listings from a
          market source — e.g. “undercut CardTrader by 5%, minimum 1 PKN”.
        </p>
      ) : (
        <div className="ps-list">
          {strategies.map((strategy) => (
            <div key={strategy.id} className={`ps-item${strategy.enabled === false ? ' is-off' : ''}`}>
              <div className="ps-item-main">
                <strong>{strategy.name}</strong>
                <span className="ps-item-sub">{summaryLine(strategy)}</span>
              </div>
              <div className="ps-item-actions">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={Boolean(busy)}
                  onClick={() => openApply(strategy)}
                >
                  {busy === `apply-${strategy.id}` ? 'Previewing…' : 'Apply…'}
                </button>
                <button type="button" className="btn ghost" onClick={() => setDraft({ ...EMPTY_STRATEGY, ...strategy })}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={Boolean(busy)}
                  onClick={() => persist({ strategy: { ...strategy, enabled: strategy.enabled === false } }, '')}
                >
                  {strategy.enabled === false ? 'Enable' : 'Disable'}
                </button>
                <button
                  type="button"
                  className="btn ghost ps-delete"
                  disabled={Boolean(busy)}
                  onClick={() => remove(strategy.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {applyState ? (
        <div className="ps-apply" data-testid="strategy-apply">
          <h3>
            Apply “{applyState.strategy.name}” — {applyState.plan.length}
            {' '}
            {applyState.plan.length === 1 ? 'listing changes' : 'listing changes'}
          </h3>
          {applyState.plan.length ? (
            <>
              <div className="ps-apply-table">
                <div className="ps-apply-head">
                  <span>Listing</span><span>Current</span><span>New</span><span className="num">Δ</span>
                </div>
                {applyState.plan.map((entry) => (
                  <div key={entry.row.id} className="ps-apply-row">
                    <span>{entry.row.cardName || entry.row.name || 'Listing'}</span>
                    <span>{formatPknLite(entry.current)}</span>
                    <span className="ps-new">{formatPknLite(entry.target)}</span>
                    <span className={`num ${entry.target > entry.current ? 'is-up' : 'is-down'}`}>
                      {entry.target > entry.current ? '+' : ''}
                      {formatPknLite(entry.target - entry.current)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="ps-actions">
                {!applyState.done ? (
                  <button type="button" className="btn" disabled={busy === 'run'} onClick={runApply}>
                    {busy === 'run'
                      ? `Repricing… ${applyState.progress}/${applyState.plan.length}`
                      : `Reprice ${applyState.plan.length} ${applyState.plan.length === 1 ? 'listing' : 'listings'}`}
                  </button>
                ) : (
                  <p className="ct-connect-ok" role="status">
                    Repriced {applyState.progress}/{applyState.plan.length} listings.
                  </p>
                )}
                <button type="button" className="btn ghost" onClick={() => setApplyState(null)}>Close</button>
              </div>
            </>
          ) : (
            <p className="seller-panel-empty">
              No changes — every matching listing already sits at this strategy's target.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatPknLite(value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2)} PKN`;
}

/** Pricer defaults editor (MyPokoin settings tab). */
export function PricerDefaults({ settings, onSaved }) {
  const { getBearer } = useAuth();
  const [draft, setDraft] = useState(settings || { defaultSource: 'cardtrader', autoMarketColumn: false });
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(settings || { defaultSource: 'cardtrader', autoMarketColumn: false }), [settings]);

  async function save(next) {
    setDraft(next);
    setSaved(false);
    const token = await getBearer();
    const data = await savePricingStrategies({ pricerSettings: next }, token);
    onSaved?.(data.pricerSettings || next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="ps-defaults">
      <label className="ps-field">
        <span>Default pricer source</span>
        <select value={draft.defaultSource} onChange={(event) => save({ ...draft, defaultSource: event.target.value })}>
          <option value="cardtrader">CardTrader</option>
          <option value="pokoin">Pokoin</option>
        </select>
      </label>
      <label className="ps-field ps-check">
        <input
          type="checkbox"
          checked={draft.autoMarketColumn === true}
          onChange={(event) => save({ ...draft, autoMarketColumn: event.target.checked })}
        />
        <span>Show the market column on the listings board</span>
      </label>
      {saved ? <span className="ct-connect-ok">Saved.</span> : null}
    </div>
  );
}
