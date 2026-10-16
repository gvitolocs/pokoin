import { createEffect, createSignal, For, Match, Show, Switch } from 'solid-js';
import {
  deletePricingStrategy,
  fetchPriceCheck,
  fetchPricingStrategies,
  fetchSellerListings,
  savePricingStrategies,
  updateListing,
} from '@market/api.js';
import { liveInventoryListings, strategyMatchesListing } from '@market/inventory-listings.js';
import { priceCheckItem, priceCheckKey } from '@market/inventory-price.js';
import { accountProfile } from '../../stores/account.js';
import { authUid, getBearer } from '../../stores/auth.js';

const SOURCES = [
  { id: 'pokoin', label: 'Pokoin' },
  { id: 'cardtrader', label: 'CardTrader' },
];

const ACTIONS = [
  { id: 'match', label: 'Match the market price' },
  { id: 'undercut', label: 'Undercut the market' },
  { id: 'premium', label: 'Sit above the market' },
];

const CONDITIONS = ['NM', 'SP', 'MP', 'PL', 'Poor'];
const LANGUAGES = ['EN', 'IT', 'DE', 'FR', 'ES', 'JP', 'KO', 'PT', 'NL', 'PL', 'RU', 'ZH', 'ZHT'];

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

function formatPknLite(value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2)} PKN`;
}

const sellerUid = () => authUid() || accountProfile()?.uid || '';

/**
 * PowerTools-style pricing strategies:
 * any number of rules, applied to live inventory after a dry-run preview.
 */
export default function PricingStrategies(props) {
  const [strategies, setStrategies] = createSignal(null);
  const [draft, setDraft] = createSignal(null);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [applyState, setApplyState] = createSignal(null);

  async function load() {
    const token = await getBearer();
    const data = await fetchPricingStrategies(token);
    setStrategies(data.strategies || []);
  }

  createEffect(() => (props.preview ? 'preview' : ''), (on) => {
    if (on) setStrategies(props.previewStrategies || []);
  });

  createEffect(sellerUid, (uid) => {
    if (props.preview || !uid) return undefined;
    let cancelled = false;
    load().catch((err) => !cancelled && setError(err.message || 'Could not load strategies.'));
    return () => { cancelled = true; };
  });

  async function persist(body) {
    if (props.preview) {
      const strategy = { ...body.strategy, id: body.strategy.id || `preview-${Date.now()}` };
      setStrategies((current) => {
        const list = current || [];
        const index = list.findIndex((row) => row.id === strategy.id);
        if (index >= 0) return list.map((row, i) => (i === index ? strategy : row));
        return [...list, strategy];
      });
      setDraft(null);
      return;
    }
    setBusy('save');
    setError('');
    try {
      const token = await getBearer();
      const data = await savePricingStrategies(body, token);
      setStrategies(data.strategies || []);
      setDraft(null);
    } catch (err) {
      setError(err.message || 'Save failed.');
    } finally {
      setBusy('');
    }
  }

  async function remove(id) {
    if (props.preview) {
      setStrategies((current) => (current || []).filter((row) => row.id !== id));
      return;
    }
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
    if (props.preview) {
      setApplyState({ strategy, plan: [], done: true, progress: 0 });
      return;
    }
    setBusy(`apply-${strategy.id}`);
    setError('');
    setApplyState(null);
    try {
      const token = await getBearer();
      const data = await fetchSellerListings(sellerUid(), token, { limit: 1000 });
      const rows = liveInventoryListings(data.listings || data.items || [])
        .filter((row) => strategyMatchesListing(strategy, row));
      const items = rows.slice(0, 100).map(priceCheckItem).filter((item) => /^\d+$/.test(item.cardId));
      const comps = items.length ? await fetchPriceCheck(items, token) : { prices: {} };
      const plan = rows.slice(0, 100).map((row) => {
        const cardId = String(row?.cardId || row?.card_id || '');
        const comp = comps.prices?.[priceCheckKey(row)] || comps.prices?.[cardId] || {};
        // CardTrader: the cheapest professional seller with the same
        // condition, language and finish, or no target at all.
        const compPkn = strategy.source === 'pokoin'
          ? (comp.pokoinCheapestPkn ?? comp.soldMedianPkn ?? null)
          : (comp.ctMatchedPkn ?? null);
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
    if (props.preview) return;
    const { plan } = applyState();
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
      props.onApplied?.();
    } catch (err) {
      setError(`Repricing stopped at ${done}/${plan.length}: ${err.message || 'update failed.'}`);
      setApplyState((state) => ({ ...state, done: true }));
    } finally {
      setBusy('');
    }
  }

  const edit = (patch) => setDraft({ ...draft(), ...patch });

  return (
    <div class="ps-wrap">
      <div class="mypokoin-panel-head">
        <div>
          <h2>Pricing strategies</h2>
          <p class="mypokoin-help">Rules that reprice matching listings from a market source.</p>
        </div>
        <Show when={!draft()}>
          <button type="button" class="btn" onClick={() => setDraft({ ...EMPTY_STRATEGY })}>New pricing strategy</button>
        </Show>
      </div>
      <Show when={error()}><p class="ct-connect-err" role="alert">{error()}</p></Show>

      <Show when={draft()}>
        {(editor) => (
          <div class="ps-editor" data-testid="strategy-editor">
            <h3>{editor().id ? 'Edit strategy' : 'New pricing strategy'}</h3>
            <div class="ps-grid">
              <label class="ps-field">
                <span>Name</span>
                <input value={editor().name} onInput={(event) => edit({ name: event.target.value })} placeholder="Undercut CardTrader by 5%" />
              </label>
              <label class="ps-field">
                <span>Comp source</span>
                <select value={editor().source} onChange={(event) => edit({ source: event.target.value })}>
                  <For each={SOURCES}>{(source) => <option value={source.id}>{source.label}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Action</span>
                <select value={editor().action} onChange={(event) => edit({ action: event.target.value })}>
                  <For each={ACTIONS}>{(action) => <option value={action.id}>{action.label}</option>}</For>
                </select>
              </label>
              <Show when={editor().action !== 'match'}>
                <label class="ps-field">
                  <span>Amount %</span>
                  <input type="number" min="0" max="90" step="0.5" value={editor().amountPct} onInput={(event) => edit({ amountPct: Number(event.target.value) })} />
                </label>
                <label class="ps-field">
                  <span>Plus PKN</span>
                  <input type="number" min="0" step="1" value={editor().amountPkn} onInput={(event) => edit({ amountPkn: Number(event.target.value) })} />
                </label>
              </Show>
              <label class="ps-field">
                <span>Floor PKN</span>
                <input type="number" min="0" step="1" value={editor().minPkn} onInput={(event) => edit({ minPkn: Number(event.target.value) })} />
              </label>
              <label class="ps-field">
                <span>Rounding</span>
                <select value={editor().rounding} onChange={(event) => edit({ rounding: event.target.value })}>
                  <option value="none">Exact</option>
                  <option value="integer">Whole PKN</option>
                </select>
              </label>
              <label class="ps-field">
                <span>Condition scope</span>
                <select value={editor().condition} onChange={(event) => edit({ condition: event.target.value })}>
                  <option value="">All conditions</option>
                  <For each={CONDITIONS}>{(key) => <option value={key}>{key}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Language scope</span>
                <select value={editor().language} onChange={(event) => edit({ language: event.target.value })}>
                  <option value="">All languages</option>
                  <For each={LANGUAGES}>{(key) => <option value={key}>{key}</option>}</For>
                </select>
              </label>
              <label class="ps-field ps-check">
                <input type="checkbox" checked={editor().enabled} onChange={(event) => edit({ enabled: event.target.checked })} />
                <span>Enabled</span>
              </label>
            </div>
            <div class="ps-actions">
              <button type="button" class="btn" disabled={busy() === 'save' || !editor().name} onClick={() => persist({ strategy: editor() })}>
                {busy() === 'save' ? 'Saving…' : 'Save strategy'}
              </button>
              <button type="button" class="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Show>

      <Switch>
        <Match when={strategies() === null}><p class="seller-panel-empty">Loading strategies…</p></Match>
        <Match when={!strategies().length}>
          <p class="seller-panel-empty">
            No pricing strategies yet. A strategy reprices matching listings from a
            market source — e.g. “undercut CardTrader by 5%, minimum 1 PKN”.
          </p>
        </Match>
        <Match when={true}>
          <div class="ps-list">
            <For each={strategies()}>
              {(strategy) => (
                <div class={['ps-item', { 'is-off': strategy.enabled === false }]}>
                  <div class="ps-item-main">
                    <strong>{strategy.name}</strong>
                    <span class="ps-item-sub">{summaryLine(strategy)}</span>
                  </div>
                  <div class="ps-item-actions">
                    <button type="button" class="btn ghost" disabled={Boolean(busy())} onClick={() => openApply(strategy)}>
                      {busy() === `apply-${strategy.id}` ? 'Previewing…' : 'Apply…'}
                    </button>
                    <button type="button" class="btn ghost" onClick={() => setDraft({ ...EMPTY_STRATEGY, ...strategy })}>Edit</button>
                    <button
                      type="button"
                      class="btn ghost"
                      disabled={Boolean(busy())}
                      onClick={() => persist({ strategy: { ...strategy, enabled: strategy.enabled === false } })}
                    >
                      {strategy.enabled === false ? 'Enable' : 'Disable'}
                    </button>
                    <button type="button" class="btn ghost ps-delete" disabled={Boolean(busy())} onClick={() => remove(strategy.id)}>Delete</button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Match>
      </Switch>

      <Show when={applyState()}>
        {(state) => (
          <div class="ps-apply" data-testid="strategy-apply">
            <h3>
              Apply “{state().strategy.name}” — {state().plan.length}
              {' '}
              listing changes
            </h3>
            <Show
              when={state().plan.length}
              fallback={<p class="seller-panel-empty">No changes — every matching listing already sits at this strategy's target.</p>}
            >
              <div class="ps-apply-table">
                <div class="ps-apply-head">
                  <span>Listing</span><span>Current</span><span>New</span><span class="num">Δ</span>
                </div>
                <For each={state().plan}>
                  {(entry) => (
                    <div class="ps-apply-row">
                      <span>{entry.row.cardName || entry.row.name || 'Listing'}</span>
                      <span>{formatPknLite(entry.current)}</span>
                      <span class="ps-new">{formatPknLite(entry.target)}</span>
                      <span class={['num', entry.target > entry.current ? 'is-up' : 'is-down']}>
                        {entry.target > entry.current ? '+' : ''}
                        {formatPknLite(entry.target - entry.current)}
                      </span>
                    </div>
                  )}
                </For>
              </div>
              <div class="ps-actions">
                <Show
                  when={!state().done}
                  fallback={<p class="ct-connect-ok" role="status">Repriced {state().progress}/{state().plan.length} listings.</p>}
                >
                  <button type="button" class="btn" disabled={busy() === 'run'} onClick={runApply}>
                    {busy() === 'run'
                      ? `Repricing… ${state().progress}/${state().plan.length}`
                      : `Reprice ${state().plan.length} ${state().plan.length === 1 ? 'listing' : 'listings'}`}
                  </button>
                </Show>
                <button type="button" class="btn ghost" onClick={() => setApplyState(null)}>Close</button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

const DEFAULT_PRICER = { defaultSource: 'cardtrader', autoMarketColumn: false };

/** Pricer defaults editor (MyPokoin settings tab). */
export function PricerDefaults(props) {
  // Writable derived: follows `settings` whenever the parent loads new ones.
  const [draft, setDraft] = createSignal(() => props.settings || DEFAULT_PRICER);
  const [saved, setSaved] = createSignal(false);

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
    props.onSaved?.(data.pricerSettings || next);
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
