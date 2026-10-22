import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import {
  fetchPriceChecksByGame,
  fetchPricingStrategies,
  savePricingStrategies,
  updateListing,
} from '@market/api.js';
import { GAMES } from '@market/game.js';
import { gamePrices, priceCheckGroups, priceCheckKey } from '@market/inventory-price.js';
import {
  DEFAULT_PRICER,
  normalizePricer,
  planReprice,
  planUpdate,
  PRICER_ACTIONS,
  PRICER_BASES,
  PRICER_ROUNDINGS,
  PRICER_SOURCES,
  PRICER_STATUSES,
  pricerMatches,
  pricerSummary,
} from '@market/pricer.js';
import { getBearer } from '../../stores/auth.js';

const CONDITIONS = ['NM', 'SP', 'MP', 'PL', 'Poor'];
const LANGUAGES = ['EN', 'IT', 'DE', 'FR', 'ES', 'JP', 'KO', 'PT', 'NL', 'PL', 'RU', 'ZH', 'ZHT'];
const GAME_LABEL = Object.fromEntries(Object.values(GAMES).map((entry) => [entry.id, entry.name]));
/** Items per price check request (server MAX_ITEMS). */
const CHECK_CHUNK = 100;
/** Listing updates in flight at once while applying. */
const APPLY_PARALLEL = 4;

const pkn = (value) => {
  const number = Math.round((Number(value) || 0) * 100) / 100;
  return `${Number.isInteger(number) ? number : number.toFixed(2)} PKN`;
};

/**
 * Comps for every distinct card + facet of `rows`, one request per game and
 * 100 keys: 1,440 Riftbound copies are about a hundred keys.
 */
async function compsFor(rows, fallbackGame, token, onProgress) {
  const unique = new Map();
  for (const row of rows) {
    const key = `${String(row?.marketplaceGame || row?.marketplace_game || fallbackGame)}|${priceCheckKey(row)}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  const distinct = [...unique.values()];
  const byGame = {};
  for (let start = 0; start < distinct.length; start += CHECK_CHUNK) {
    const chunk = distinct.slice(start, start + CHECK_CHUNK);
    const answers = await fetchPriceChecksByGame(priceCheckGroups(chunk, fallbackGame, { limit: CHECK_CHUNK }), token);
    for (const [game, prices] of Object.entries(answers)) {
      if (!prices) throw new Error(`The ${GAME_LABEL[game] || game} price check failed.`);
      byGame[game] = { ...(byGame[game] || {}), ...prices };
    }
    onProgress?.(Math.min(distinct.length, start + CHECK_CHUNK), distinct.length);
  }
  return byGame;
}

/**
 * The listings board's Pricer: pick or build a pricing strategy (the same
 * users/{uid} strategies as Settings → Pricing strategies), preview what it
 * does to the listings in scope, then apply it. Nothing changes before
 * "Apply".
 */
export default function PricerDialog(props) {
  const [strategies, setStrategies] = createSignal(props.preview ? (props.previewStrategies || []) : null);
  const [draft, setDraft] = createSignal(normalizePricer({ ...DEFAULT_PRICER, ...(props.initial || {}) }));
  const [scope, setScope] = createSignal('filtered');
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal('');
  const [result, setResult] = createSignal(null);
  const [applied, setApplied] = createSignal(null);

  createEffect(() => (props.open ? { preview: Boolean(props.preview) } : null), (open) => {
    if (!open) return undefined;
    setResult(null);
    setApplied(null);
    setError('');
    if (open.preview) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchPricingStrategies(token))
      .then((data) => !cancelled && setStrategies(data.strategies || []))
      .catch((err) => !cancelled && setError(err.message || 'Could not load your pricing strategies.'));
    return () => { cancelled = true; };
  });

  const edit = (patch) => {
    setDraft(normalizePricer({ ...draft(), ...patch }));
    setResult(null);
    setApplied(null);
  };
  const baseRows = () => (scope() === 'filtered' ? (props.filteredRows || []) : (props.rows || []));
  const games = createMemo(() => [...new Set((props.rows || []).map((row) => String(row?.marketplaceGame || row?.marketplace_game || props.gameId || 'pokemon')))]);

  function choose(id) {
    const found = (strategies() || []).find((entry) => entry.id === id);
    setDraft(normalizePricer(found || { ...DEFAULT_PRICER }));
    setResult(null);
    setApplied(null);
  }

  async function preview() {
    setBusy('preview');
    setError('');
    setResult(null);
    setApplied(null);
    try {
      const strategy = draft();
      const rows = baseRows();
      let comps;
      if (props.preview) {
        comps = props.previewComps || {};
      } else {
        const token = await getBearer();
        const scoped = rows.filter((row) => pricerMatches(strategy, row, props.gameId || 'pokemon'));
        setProgress(`Checking prices for ${scoped.length} listings…`);
        comps = await compsFor(scoped, props.gameId || 'pokemon', token, (done, total) => setProgress(`Checking prices… ${done}/${total}`));
      }
      const compFor = (row) => {
        const prices = props.preview ? comps : gamePrices(comps, row, props.gameId || 'pokemon');
        return prices[priceCheckKey(row)] || prices[String(row?.cardId || row?.card_id || '')] || null;
      };
      setResult(planReprice(rows, compFor, strategy, props.gameId || 'pokemon'));
    } catch (err) {
      setError(err.message || 'The preview failed.');
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  async function apply() {
    const plan = result()?.plan || [];
    if (!plan.length) return;
    if (props.preview) {
      setApplied({ done: plan.length, total: plan.length, failed: 0 });
      return;
    }
    setBusy('apply');
    setError('');
    let done = 0;
    let failed = 0;
    let firstError = '';
    try {
      const token = await getBearer();
      let next = 0;
      const worker = async () => {
        while (next < plan.length) {
          const entry = plan[next];
          next += 1;
          try {
            await updateListing(entry.row.id, planUpdate(entry), token);
            done += 1;
          } catch (err) {
            failed += 1;
            firstError = firstError || err.message || 'update failed';
          }
          setApplied({ done, total: plan.length, failed });
        }
      };
      await Promise.all(Array.from({ length: Math.min(APPLY_PARALLEL, plan.length) }, worker));
      if (failed) setError(`${failed} listing${failed === 1 ? '' : 's'} could not be updated: ${firstError}`);
      props.onApplied?.();
    } catch (err) {
      setError(err.message || 'Applying stopped.');
    } finally {
      setBusy('');
    }
  }

  async function save() {
    const strategy = draft();
    if (!strategy.name.trim()) {
      setError('Give the strategy a name to save it.');
      return;
    }
    if (props.preview) {
      const saved = { ...strategy, id: strategy.id || `preview-${Date.now()}` };
      setStrategies([...(strategies() || []).filter((entry) => entry.id !== saved.id), saved]);
      setDraft(normalizePricer(saved));
      return;
    }
    setBusy('save');
    setError('');
    try {
      const token = await getBearer();
      const data = await savePricingStrategies({ strategy }, token);
      setStrategies(data.strategies || []);
      const saved = (data.strategies || []).find((entry) => entry.name === strategy.name && (!strategy.id || entry.id === strategy.id));
      if (saved) setDraft(normalizePricer(saved));
    } catch (err) {
      setError(err.message || 'Save failed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <Show when={props.open}>
      <div class="modal-backdrop pricer-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && props.onClose?.()}>
        <div class="pricer-dialog" role="dialog" aria-modal="true" aria-labelledby="pricer-title" data-testid="pricer-dialog">
          <div class="pricer-head">
            <div>
              <h2 id="pricer-title">Pricer</h2>
              <p class="mypokoin-help">{pricerSummary(draft())}</p>
            </div>
            <button type="button" class="pricer-close" aria-label="Close" onClick={() => props.onClose?.()}>×</button>
          </div>

          <div class="pricer-row">
            <label class="ps-field pricer-strategy">
              <span>Strategy</span>
              <select value={draft().id || ''} onChange={(event) => choose(event.target.value)}>
                <option value="">New strategy</option>
                <For each={strategies() || []}>{(entry) => <option value={entry.id}>{entry.name}</option>}</For>
              </select>
            </label>
            <label class="ps-field pricer-name">
              <span>Name</span>
              <input value={draft().name} placeholder="Match CardTrader, net of fees" onInput={(event) => edit({ name: event.target.value })} />
            </label>
          </div>

          <fieldset class="pricer-group">
            <legend>Market price</legend>
            <div class="pricer-chips" role="group" aria-label="Source">
              <For each={PRICER_SOURCES}>
                {(entry) => (
                  <button type="button" class={['inv-chip', { on: draft().source === entry.id }]} aria-pressed={draft().source === entry.id} onClick={() => edit({ source: entry.id })}>
                    {entry.label}
                  </button>
                )}
              </For>
              <button type="button" class="inv-chip inv-src" disabled title="eBay prices are not connected yet">eBay</button>
              <button type="button" class="inv-chip inv-src" disabled title="TCGplayer quotes are USD and condition-free: shown in the column, not used to price">TCGplayer</button>
            </div>
            <div class="pricer-chips" role="group" aria-label="Price basis">
              <For each={PRICER_BASES}>
                {(entry) => (
                  <button type="button" class={['inv-chip', { on: draft().basis === entry.id }]} title={entry.hint} aria-pressed={draft().basis === entry.id} onClick={() => edit({ basis: entry.id })}>
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={draft().source === 'cardtrader' || draft().basis === 'sold'}>
              <label class="ps-field ps-check pricer-fee">
                <input type="checkbox" checked={draft().feeExclusive} onChange={(event) => edit({ feeExclusive: event.target.checked })} />
                <span>
                  Net of CardTrader fees
                  <small>What a seller keeps after CardTrader's commission (5 % direct / 7 % Zero, min 1 cent, + 22 % VAT). Off: the CardTrader ask itself.</small>
                </span>
              </label>
            </Show>
          </fieldset>

          <fieldset class="pricer-group">
            <legend>Your price</legend>
            <div class="pricer-chips" role="group" aria-label="Action">
              <For each={PRICER_ACTIONS}>
                {(entry) => (
                  <button type="button" class={['inv-chip', { on: draft().action === entry.id }]} aria-pressed={draft().action === entry.id} onClick={() => edit({ action: entry.id })}>
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
            <div class="pricer-grid">
              <Show when={draft().action !== 'match'}>
                <label class="ps-field">
                  <span>{draft().action === 'undercut' ? 'Below by %' : 'Above by %'}</span>
                  <input type="number" min="0" max="90" step="0.5" value={draft().amountPct} onInput={(event) => edit({ amountPct: Number(event.target.value) })} />
                </label>
                <label class="ps-field">
                  <span>{draft().action === 'undercut' ? 'and minus PKN' : 'and plus PKN'}</span>
                  <input type="number" min="0" step="1" value={draft().amountPkn} onInput={(event) => edit({ amountPkn: Number(event.target.value) })} />
                </label>
              </Show>
              <label class="ps-field">
                <span>Rounding</span>
                <select value={draft().rounding} onChange={(event) => edit({ rounding: event.target.value })}>
                  <For each={PRICER_ROUNDINGS}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Minimum PKN</span>
                <input type="number" min="0" step="1" value={draft().minPkn} onInput={(event) => edit({ minPkn: Number(event.target.value) })} />
              </label>
            </div>
          </fieldset>

          <fieldset class="pricer-group">
            <legend>Which listings</legend>
            <div class="pricer-chips" role="group" aria-label="Apply to">
              <button type="button" class={['inv-chip', { on: scope() === 'filtered' }]} onClick={() => { setScope('filtered'); setResult(null); }}>
                Board view ({(props.filteredRows || []).length})
              </button>
              <button type="button" class={['inv-chip', { on: scope() === 'all' }]} onClick={() => { setScope('all'); setResult(null); }}>
                All listings ({(props.rows || []).length})
              </button>
            </div>
            <div class="pricer-grid">
              <label class="ps-field">
                <span>Game</span>
                <select value={draft().game} onChange={(event) => edit({ game: event.target.value })}>
                  <option value="">Every game</option>
                  <For each={games()}>{(id) => <option value={id}>{GAME_LABEL[id] || id}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Status</span>
                <select value={draft().status} onChange={(event) => edit({ status: event.target.value })}>
                  <For each={PRICER_STATUSES}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Condition</span>
                <select value={draft().condition} onChange={(event) => edit({ condition: event.target.value })}>
                  <option value="">Any condition</option>
                  <For each={CONDITIONS}>{(key) => <option value={key}>{key}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Language</span>
                <select value={draft().language} onChange={(event) => edit({ language: event.target.value })}>
                  <option value="">Any language</option>
                  <For each={LANGUAGES}>{(key) => <option value={key}>{key}</option>}</For>
                </select>
              </label>
            </div>
            <label class="ps-field ps-check">
              <input type="checkbox" checked={draft().activatePaused} onChange={(event) => edit({ activatePaused: event.target.checked })} />
              <span>Put paused listings on sale once they have a price</span>
            </label>
          </fieldset>

          <Show when={error()}><p class="ct-connect-err" role="alert">{error()}</p></Show>
          <Show when={progress()}><p class="mypokoin-help" role="status">{progress()}</p></Show>

          <Show when={result()}>
            {(plan) => (
              <div class="pricer-result" data-testid="pricer-plan">
                <p class="pricer-counts">
                  <strong>{plan().plan.length}</strong> to change
                  {' · '}{plan().plan.filter((entry) => entry.activate).length} go on sale
                  {' · '}{plan().unchanged} already there
                  {' · '}{plan().noComp} without a market price
                  {' · '}{plan().scoped} in scope
                </p>
                <Show when={plan().plan.length}>
                  <div class="ps-apply-table pricer-table">
                    <div class="ps-apply-head">
                      <span>Listing</span><span>Market</span><span>Now</span><span>New</span>
                    </div>
                    <For each={plan().plan.slice(0, 60)}>
                      {(entry) => (
                        <div class="ps-apply-row">
                          <span>
                            {entry.row.cardName || entry.row.name || 'Listing'}
                            <small>{[entry.row.condition, entry.row.language, entry.row.collectorNumber ? `#${entry.row.collectorNumber}` : ''].filter(Boolean).join(' · ')}</small>
                          </span>
                          <span title={entry.askPkn ? `CardTrader ask ${pkn(entry.askPkn)}` : ''}>
                            {pkn(entry.compPkn)}
                            <Show when={entry.askPkn && draft().feeExclusive && draft().source === 'cardtrader'}>
                              <small> ask {pkn(entry.askPkn)}</small>
                            </Show>
                          </span>
                          <span>{entry.current ? pkn(entry.current) : '—'}</span>
                          <span class="ps-new">
                            {pkn(entry.target)}
                            <Show when={entry.activate}><small class="pricer-live"> → live</small></Show>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={plan().plan.length > 60}>
                    <p class="mypokoin-help">…and {plan().plan.length - 60} more.</p>
                  </Show>
                </Show>
              </div>
            )}
          </Show>
          <Show when={applied()}>
            {(state) => (
              <p class={state().done === state().total ? 'ct-connect-ok' : 'mypokoin-help'} role="status">
                Updated {state().done}/{state().total} listings{state().failed ? `, ${state().failed} failed` : ''}.
                {' '}CardTrader-linked listings follow on CardTrader at the ask that nets the new price.
              </p>
            )}
          </Show>

          <div class="ps-actions pricer-actions">
            <button type="button" class="btn ghost" disabled={busy() === 'save'} onClick={save}>
              {busy() === 'save' ? 'Saving…' : draft().id ? 'Save strategy' : 'Save as strategy'}
            </button>
            <span class="pricer-spacer" />
            <button type="button" class="btn ghost" disabled={Boolean(busy())} onClick={preview}>
              {busy() === 'preview' ? 'Checking…' : 'Preview'}
            </button>
            <button
              type="button"
              class="btn"
              disabled={Boolean(busy()) || !result()?.plan.length || Boolean(applied())}
              onClick={apply}
            >
              {busy() === 'apply'
                ? `Applying… ${applied()?.done || 0}/${result()?.plan.length || 0}`
                : `Apply to ${result()?.plan.length || 0} listing${result()?.plan.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
